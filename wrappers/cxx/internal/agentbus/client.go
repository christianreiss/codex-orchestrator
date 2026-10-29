package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	envSocket    = "CXX_AGENT_PORTAL_SOCKET"
	envSessionID = "CXX_AGENT_PORTAL_SESSION_ID"
	maxBodyBytes = 32 * 1024
)

type APIError struct {
	Status  int
	Code    string
	Message string
	Path    string
	// RetryAfter carries the server's Retry-After header when it sent one.
	// Zero means it did not; it is a hint, and callers still clamp it.
	RetryAfter time.Duration
}

// parseRetryAfter reads the delta-seconds form of Retry-After. The HTTP-date
// form is deliberately not accepted: this API only ever sends seconds, and
// trusting a clock-dependent value from the wire would let a skewed server
// park the relay for hours.
func parseRetryAfter(raw string) time.Duration {
	seconds, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || seconds <= 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("agent messaging %s: %s (%s)", messagingOperation(e.Path), e.Message, e.Code)
	}
	return fmt.Sprintf("agent messaging %s: HTTP %d: %s", messagingOperation(e.Path), e.Status, e.Message)
}

type sessionClient struct {
	socket string
	id     string
	http   *http.Client
}

func sessionClientFromEnv(timeout time.Duration) (*sessionClient, error) {
	socket := strings.TrimSpace(os.Getenv(envSocket))
	id := strings.TrimSpace(os.Getenv(envSessionID))
	if socket == "" || id == "" {
		return nil, errors.New("agent messaging is available only inside a managed cdx/clx/cgx lifecycle; " + hostInventoryHint)
	}
	return sessionClientAt(socket, id, timeout), nil
}

func sessionClientAt(socket, id string, timeout time.Duration) *sessionClient {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
		MaxIdleConns:          2,
		IdleConnTimeout:       30 * time.Second,
		ResponseHeaderTimeout: timeout,
	}
	return &sessionClient{
		id:     id,
		socket: socket,
		http:   &http.Client{Transport: transport, Timeout: timeout},
	}
}

func (c *sessionClient) path(suffix string) string {
	return "/host/agent-sessions/" + url.PathEscape(c.id) + "/agent-messaging/" + suffix
}

func (c *sessionClient) post(ctx context.Context, suffix string, body any, out any) error {
	err := doJSON(ctx, c.http, "http://agent-messaging.local", http.MethodPost, c.path(suffix), body, nil, out)
	// This exact broker rejection happens before bridgeJSON: nothing has been
	// dispatched, even for acquire/release or an owner's status response. Wait
	// for the same native attachment, preserving the operation body and IDs.
	if suffix == "claims/acquire" || suffix == "claims/status" || suffix == "claims/release" {
		err = c.waitClaimAttachment(ctx, suffix, body, out, err)
	}
	args, _ := body.(map[string]any)
	// Status/renewal is retry-safe; owner responses and work mutations are not
	// replayed here. A bounded reconnect gap must not strand a healthy claim.
	if suffix != "claims/status" || stringArg(args, "response") != "" {
		return err
	}
	for _, delay := range []time.Duration{250 * time.Millisecond, time.Second} {
		var api *APIError
		if !errors.As(err, &api) || !(api.Status == 502 || api.Status == 504 ||
			api.Status == 503 && (api.Code == "communicator_unavailable" || api.Code == "broker_upstream_unavailable" || api.Code == "")) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
		err = doJSON(ctx, c.http, "http://agent-messaging.local", http.MethodPost, c.path(suffix), body, nil, out)
	}
	return err
}

// Do not broaden this to transport errors: a lost response can hide a
// committed mutation. Only the broker's explicit pre-dispatch rejection is safe.
func (c *sessionClient) waitClaimAttachment(ctx context.Context, suffix string, body, out any, err error) error {
	var api *APIError
	if !errors.As(err, &api) || api.Status != http.StatusServiceUnavailable || api.Code != "native_attachment_unavailable" {
		return err
	}
	reconnectCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	delay := 250 * time.Millisecond
	for {
		timer := time.NewTimer(delay)
		select {
		case <-reconnectCtx.Done():
			timer.Stop()
			return errors.Join(err, reconnectCtx.Err())
		case <-timer.C:
		}
		err = doJSON(reconnectCtx, c.http, "http://agent-messaging.local", http.MethodPost, c.path(suffix), body, nil, out)
		if !errors.As(err, &api) || api.Status != http.StatusServiceUnavailable || api.Code != "native_attachment_unavailable" {
			return err
		}
		delay = min(2*time.Second, delay*2)
	}
}

func doJSON(
	ctx context.Context,
	client *http.Client,
	baseURL, method, path string,
	body any,
	headers map[string]string,
	out any,
) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(baseURL, "/")+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "cxx-agent-messaging/1")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		if strings.TrimSpace(value) != "" {
			req.Header.Set(key, value)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return fmt.Errorf("agent messaging %s %s: %w", method, messagingOperation(path), err)
	}
	defer resp.Body.Close()
	limit := int64(2 << 20)
	if strings.HasSuffix(path, "/attachments/get") {
		limit = 6 << 20
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if int64(len(raw)) > limit {
		return errors.New("agent messaging response too large")
	}
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		var failure struct {
			Message string `json:"message"`
			Code    string `json:"code"`
			Error   *struct {
				Message string `json:"message"`
				Code    string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &failure)
		if failure.Error != nil {
			if failure.Message == "" {
				failure.Message = failure.Error.Message
			}
			if failure.Code == "" {
				failure.Code = failure.Error.Code
			}
		}
		if failure.Message == "" {
			failure.Message = http.StatusText(resp.StatusCode)
		}
		return &APIError{
			Status:     resp.StatusCode,
			Code:       failure.Code,
			Message:    failure.Message,
			Path:       path,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
		}
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	payload := raw
	if json.Unmarshal(raw, &envelope) == nil && len(envelope.Data) > 0 && string(envelope.Data) != "null" {
		payload = envelope.Data
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("agent messaging %s: decode response: %w", messagingOperation(path), err)
	}
	return nil
}

func readMessageBody(r io.Reader, explicitStdin bool) (string, error) {
	if !explicitStdin {
		return "", errors.New("--stdin is required; message bodies are never accepted in argv")
	}
	raw, err := io.ReadAll(io.LimitReader(r, maxBodyBytes+1))
	if err != nil {
		return "", err
	}
	if len(raw) > maxBodyBytes {
		return "", errors.New("message body exceeds 32 KiB")
	}
	if strings.TrimSpace(string(raw)) == "" {
		return "", errors.New("message body must not be empty")
	}
	return string(raw), nil
}

func writeJSON(w io.Writer, value any) error {
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

// Keep the operation and error code in diagnostics without exposing session IDs.
func messagingOperation(path string) string {
	if strings.HasPrefix(path, "/host/agent-sessions/") {
		scoped := strings.TrimPrefix(path, "/host/agent-sessions/")
		if _, suffix, ok := strings.Cut(scoped, "/"); ok {
			return strings.TrimPrefix(suffix, "agent-messaging/")
		}
	}
	return path
}

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
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("agent messaging %s: %s (%s)", e.Path, e.Message, e.Code)
	}
	return fmt.Sprintf("agent messaging %s: HTTP %d: %s", e.Path, e.Status, e.Message)
}

type sessionClient struct {
	id   string
	http *http.Client
}

func sessionClientFromEnv(timeout time.Duration) (*sessionClient, error) {
	socket := strings.TrimSpace(os.Getenv(envSocket))
	id := strings.TrimSpace(os.Getenv(envSessionID))
	if socket == "" || id == "" {
		return nil, errors.New("agent messaging is available only inside a managed cdx/clx lifecycle")
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
		MaxIdleConns:          2,
		IdleConnTimeout:       30 * time.Second,
		ResponseHeaderTimeout: timeout,
	}
	return &sessionClient{
		id:   id,
		http: &http.Client{Transport: transport, Timeout: timeout},
	}, nil
}

func (c *sessionClient) path(suffix string) string {
	return "/host/agent-sessions/" + url.PathEscape(c.id) + "/agent-messaging/" + suffix
}

func (c *sessionClient) post(ctx context.Context, suffix string, body any, out any) error {
	return doJSON(ctx, c.http, "http://agent-messaging.local", http.MethodPost, c.path(suffix), body, nil, out)
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
		return fmt.Errorf("agent messaging %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
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
		return &APIError{Status: resp.StatusCode, Code: failure.Code, Message: failure.Message, Path: path}
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
		return fmt.Errorf("agent messaging %s: decode response: %w", path, err)
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

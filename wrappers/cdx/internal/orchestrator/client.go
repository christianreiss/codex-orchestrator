// Package orchestrator is the HTTP client cdx uses to talk to the central
// orchestrator. All endpoint shapes are stable contracts owned by the PHP side.
package orchestrator

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"
)

const (
	defaultTimeout = 30 * time.Second
	userAgent      = "cdx/wrapper-v2"
)

// Client wraps net/http with the per-host API key, retry logic, and a base URL.
type Client struct {
	BaseURL   string
	APIKey    string
	HTTP      *http.Client
	UserAgent string
	Logger    *slog.Logger
}

type Options struct {
	BaseURL       string
	APIKey        string
	CABundlePath  string
	AllowInsecure bool
	Timeout       time.Duration
	Logger        *slog.Logger
}

func New(opts Options) (*Client, error) {
	if strings.TrimSpace(opts.BaseURL) == "" {
		return nil, errors.New("orchestrator base URL required")
	}
	if _, err := url.Parse(opts.BaseURL); err != nil {
		return nil, fmt.Errorf("orchestrator base URL invalid: %w", err)
	}

	tlsCfg := &tls.Config{InsecureSkipVerify: opts.AllowInsecure}
	if opts.CABundlePath != "" {
		pem, err := os.ReadFile(opts.CABundlePath)
		if err != nil {
			return nil, fmt.Errorf("read CA bundle: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("CA bundle contained no certificates")
		}
		tlsCfg.RootCAs = pool
	}

	timeout := opts.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}

	transport := &http.Transport{
		TLSClientConfig:       tlsCfg,
		MaxIdleConns:          10,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: timeout,
	}
	return &Client{
		BaseURL:   strings.TrimRight(opts.BaseURL, "/"),
		APIKey:    opts.APIKey,
		HTTP:      &http.Client{Transport: transport, Timeout: timeout},
		UserAgent: userAgent,
		Logger:    opts.Logger,
	}, nil
}

// Do executes a request with bounded exponential backoff. retries=0 means try
// exactly once. 5xx / network errors are retried; 4xx are returned immediately.
func (c *Client) Do(ctx context.Context, req *http.Request, retries int) (*http.Response, error) {
	if c.APIKey != "" {
		req.Header.Set("X-API-Key", c.APIKey)
	}
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "application/json")
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	if req.Header.Get("X-Wrapper-Platform") == "" {
		req.Header.Set("X-Wrapper-Platform", runtime.GOOS+"-"+runtime.GOARCH)
	}

	if retries < 0 {
		retries = 0
	}

	var lastErr error
	for attempt := 0; attempt <= retries; attempt++ {
		// Clone the body for retries since net/http drains it.
		clone := req.Clone(req.Context())
		if req.Body != nil {
			buf, err := io.ReadAll(req.Body)
			if err != nil {
				return nil, err
			}
			req.Body = io.NopCloser(bytes.NewReader(buf))
			clone.Body = io.NopCloser(bytes.NewReader(buf))
		}

		resp, err := c.HTTP.Do(clone.WithContext(ctx))
		if err != nil {
			lastErr = err
		} else if resp.StatusCode < 500 {
			return resp, nil
		} else {
			lastErr = fmt.Errorf("orchestrator %s %s -> %d", req.Method, req.URL.Path, resp.StatusCode)
			io.Copy(io.Discard, io.LimitReader(resp.Body, 2048))
			resp.Body.Close()
		}
		if attempt < retries {
			backoff := time.Duration(1<<attempt) * 200 * time.Millisecond
			jitter := time.Duration(rand.Int63n(int64(backoff / 2)))
			select {
			case <-time.After(backoff + jitter):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	}
	return nil, lastErr
}

// JSON is a convenience for POSTing JSON and decoding a JSON response envelope.
func (c *Client) JSON(ctx context.Context, method, path string, in any, out any, retries int) error {
	var body io.Reader
	if in != nil {
		buf, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(ctx, req, retries)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		io.Copy(io.Discard, resp.Body)
		return &HTTPError{
			StatusCode: resp.StatusCode,
			Code:       parseErrorCode(raw),
			Method:     method,
			Path:       path,
			Body:       strings.TrimSpace(string(raw)),
		}
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// Get is a convenience wrapper for GET requests returning a parsed body.
func (c *Client) Get(ctx context.Context, path string, out any, retries int) error {
	return c.JSON(ctx, http.MethodGet, path, nil, out, retries)
}

// HTTPError is returned by JSON-based calls when the server responds with a
// status >= 400. It carries the parsed error `code` so callers can branch on
// the stable machine-readable signal (e.g. insecure_pending) instead of
// string-matching the human message. Error() preserves the legacy
// "METHOD PATH -> STATUS: body" format other call sites already match on.
type HTTPError struct {
	StatusCode int
	Code       string
	Method     string
	Path       string
	Body       string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("%s %s -> %d: %s", e.Method, e.Path, e.StatusCode, e.Body)
}

// parseErrorCode pulls the machine code out of the orchestrator's error
// envelopes. Host sync routes normally use the standard top-level `code`
// field, but keep the OpenAI/Anthropic nested shape working too so callers can
// branch on stable codes across formatter changes.
func parseErrorCode(raw []byte) string {
	var env struct {
		Code  string `json:"code"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &env) != nil {
		return ""
	}
	if env.Code != "" {
		return env.Code
	}
	return env.Error.Code
}

// InsecureStatusFromError maps the orchestrator's insecure-approval HTTP
// responses to the auth status the launch-gate decision engine expects:
//
//	423 insecure_pending  -> "insecure"        (enter the approval poll)
//	403 insecure_denied   -> "insecure-denied" (operator rejected)
//
// Returns "" for any other error, so callers fall through to their normal
// offline/error handling. This is what keeps an insecure host from being
// reported as "API offline" while it actually waits on operator approval.
func InsecureStatusFromError(err error) string {
	var he *HTTPError
	if !errors.As(err, &he) {
		return ""
	}
	switch {
	case he.StatusCode == http.StatusLocked && he.Code == "insecure_pending":
		return "insecure"
	case he.StatusCode == http.StatusForbidden && he.Code == "insecure_denied":
		return "insecure-denied"
	}
	return ""
}

// Envelope is the orchestrator's standard `{status, data, message?, errors?}` shape.
type Envelope[T any] struct {
	Status  string         `json:"status"`
	Message string         `json:"message,omitempty"`
	Data    T              `json:"data,omitempty"`
	Errors  map[string]any `json:"errors,omitempty"`
}

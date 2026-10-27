// Package httpguard owns HTTP trust and resource limits shared by wrapper personas.
// It deliberately has no engine, credential, or communicator dependencies.
package httpguard

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const MaxJSONBytes int64 = 64 << 20

// BaseURL validates an HTTP origin with an optional path prefix. Credentials,
// queries and fragments do not belong in a configured orchestrator base URL.
func BaseURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return nil, errors.New("orchestrator base URL must be an absolute HTTP(S) URL without credentials, query or fragment")
	}
	return u, nil
}

// SameOrigin compares scheme, hostname and effective port, never just hostname.
func SameOrigin(a, b *url.URL) bool {
	if a == nil || b == nil || a.User != nil || b.User != nil || a.Hostname() == "" || b.Hostname() == "" {
		return false
	}
	port := func(u *url.URL) string {
		if p := u.Port(); p != "" {
			return p
		}
		if u.Scheme == "https" {
			return "443"
		}
		return "80"
	}
	return (a.Scheme == "http" || a.Scheme == "https") && a.Scheme == b.Scheme && strings.EqualFold(a.Hostname(), b.Hostname()) && port(a) == port(b)
}

// Redirect keeps authenticated requests and their bodies on the original origin.
// Stripping headers alone would still leak auth payloads through 307/308 replay.
func Redirect(next *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	if len(via) > 0 && !SameOrigin(next.URL, via[0].URL) {
		return errors.New("refusing cross-origin authenticated redirect")
	}
	return nil
}

// ArtifactRedirect permits public CDN downloads, but never TLS downgrades or
// credentials on another origin. Artifact bytes still require a signed digest.
func ArtifactRedirect(next *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	if next.URL.User != nil || (next.URL.Scheme != "http" && next.URL.Scheme != "https") {
		return errors.New("invalid artifact redirect")
	}
	for _, previous := range via {
		if previous.URL.Scheme == "https" && next.URL.Scheme != "https" {
			return errors.New("refusing HTTPS artifact downgrade")
		}
		if !SameOrigin(next.URL, previous.URL) {
			for _, header := range []string{"X-API-Key", "Authorization", "Proxy-Authorization", "Cookie"} {
				next.Header.Del(header)
			}
		}
	}
	return nil
}

// ReadLimit rejects overflow before a decoder can accept a valid JSON prefix.
func ReadLimit(r io.Reader, limit int64) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("HTTP response exceeds %d bytes", limit)
	}
	return raw, nil
}

// Decode accepts exactly one complete JSON document within the byte limit.
func Decode(r io.Reader, limit int64, out any) error {
	raw, err := ReadLimit(r, limit)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

// Do retries only as explicitly requested by a caller that knows its operation
// is replay-safe. Request bodies use GetBody when available; other bodies are
// buffered once with a hard cap and closed, including on preparation failure.
// The caller owns successful responses; this function closes every failed one.
func Do(ctx context.Context, client *http.Client, req *http.Request, retries int, serverError func(*http.Response, []byte) error) (*http.Response, error) {
	retries = max(0, min(retries, 5))
	if err := ctx.Err(); err != nil {
		if req.Body != nil {
			req.Body.Close()
		}
		return nil, err
	}
	if req.Body != nil && req.Body != http.NoBody {
		if retries > 0 && req.GetBody == nil {
			var once sync.Once
			closeBody := func() { once.Do(func() { _ = req.Body.Close() }) }
			stop := context.AfterFunc(ctx, closeBody)
			raw, err := ReadLimit(req.Body, MaxJSONBytes)
			stop()
			closeBody()
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if err != nil {
				return nil, fmt.Errorf("prepare request replay: %w", err)
			}
			req = req.Clone(ctx)
			req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(raw)), nil }
		} else if req.GetBody != nil {
			// Each attempt uses a new reader. Close the unused original here;
			// when GetBody is absent with no retries, the transport owns it and
			// may still be reading asynchronously after returning headers.
			_ = req.Body.Close()
		}
	}
	var lastErr error
	for attempt := 0; attempt <= retries; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		clone := req.Clone(ctx)
		if req.Body != nil && req.GetBody != nil {
			body, err := req.GetBody()
			if err != nil {
				return nil, fmt.Errorf("replay request body: %w", err)
			}
			clone.Body = body
		}
		resp, err := client.Do(clone)
		if err != nil {
			lastErr = err
		} else if resp.StatusCode < 500 {
			return resp, nil
		} else {
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			lastErr = serverError(resp, raw)
			// Never drain an unbounded error stream just to reuse a connection.
			resp.Body.Close()
		}
		// A rejected redirect returns a response plus an error. Never replay
		// the original request after this permanent policy refusal.
		if err != nil && resp != nil {
			return nil, lastErr
		}
		if attempt < retries {
			backoff := (200 * time.Millisecond) << attempt
			timer := time.NewTimer(backoff + time.Duration(rand.Int64N(int64(backoff/2))))
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			}
		}
	}
	return nil, lastErr
}

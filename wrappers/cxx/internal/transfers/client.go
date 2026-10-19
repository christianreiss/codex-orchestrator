// Package transfers moves bytes through the fleet pool without exposing them to MCP.
package transfers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
)

const chunkBytes int64 = 16 << 20

type Transfer struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Size         int64  `json:"size_bytes"`
	ExpectedSize *int64 `json:"expected_size_bytes"`
	SHA256       string `json:"content_sha256"`
	Status       string `json:"status"`
	ExpiresAt    string `json:"expires_at"`
	TTLClamped   bool   `json:"ttl_clamped"`
}
type response struct {
	Transfer   Transfer `json:"transfer"`
	ChunkBytes int64    `json:"chunk_bytes"`
}
type Client struct {
	HTTP                    *http.Client
	BaseURL, APIKey, Engine string
	Progress                io.Writer
	// Owner reads the local communicator owner that relays these requests; nil
	// (direct HTTPS, tests) skips the owner preflight.
	Owner func(ctx context.Context, base string) (communicator.Owner, bool)
}

func NewClient(cfg *config.Config, progress io.Writer) (*Client, error) {
	base, err := url.Parse(cfg.Orchestrator.BaseURL)
	if err != nil || base.User != nil || base.RawQuery != "" || base.Fragment != "" || (base.Scheme != "http" && base.Scheme != "https") {
		return nil, fmt.Errorf("transfer requires a server base URL without credentials, query or fragment")
	}
	h, err := update.HTTPClient(cfg)
	if err != nil {
		return nil, err
	}
	// Transfer duration is unbounded. Each request has a separate idle timer.
	h.Timeout = 0
	h.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{HTTP: h, BaseURL: strings.TrimRight(cfg.Orchestrator.BaseURL, "/"), APIKey: cfg.Orchestrator.APIKey, Engine: cfg.Engine, Progress: progress, Owner: communicator.OwnerStatus}, nil
}
func (c *Client) endpoint(path string) string {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return c.BaseURL + "/host/transfers" + path + sep + "engine=" + url.QueryEscape(c.Engine)
}
func (c *Client) request(ctx context.Context, method, path string, body io.Reader, length int64, binary bool) (*http.Response, context.CancelFunc, error) {
	ctx, cancel := context.WithCancel(ctx)
	timer := time.AfterFunc(2*time.Minute, cancel)
	stop := func() { timer.Stop(); cancel() }
	if body != nil {
		body = &activityReader{body, func() { timer.Reset(2 * time.Minute) }}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint(path), body)
	if err != nil {
		stop()
		return nil, func() {}, err
	}
	req.Header.Set("X-API-Key", c.APIKey)
	if body != nil {
		req.ContentLength = length
		if binary {
			req.Header.Set("Content-Type", "application/octet-stream")
		} else {
			req.Header.Set("Content-Type", "application/json")
		}
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		stop()
		return nil, func() {}, fmt.Errorf("transfer request interrupted; use --resume: %w", err)
	}
	resp.Body = &activityBody{ReadCloser: resp.Body, touch: func() { timer.Reset(2 * time.Minute) }}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		defer stop()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
		var e struct {
			Message string `json:"message"`
			Error   struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		if e.Message == "" {
			e.Message = e.Error.Message
		}
		if e.Message == "" {
			// A plain-text refusal (http.Error from a local communicator, a proxy)
			// is the only explanation the caller gets; keep it, bounded.
			e.Message = plainText(raw, 200)
		}
		return nil, func() {}, fmt.Errorf("transfer HTTP %d: %s", resp.StatusCode, e.Message)
	}
	return resp, stop, nil
}

// plainText bounds a response body to one printable line.
func plainText(raw []byte, limit int) string {
	text := strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == utf8.RuneError {
			return ' '
		}
		return r
	}, string(raw))), " ")
	if runes := []rune(text); len(runes) > limit {
		text = string(runes[:limit])
	}
	return text
}
func (c *Client) metadata(ctx context.Context, method, path string, input any) (response, error) {
	var body io.Reader
	var length int64
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			return response{}, err
		}
		body = bytes.NewReader(raw)
		length = int64(len(raw))
	}
	resp, stop, err := c.request(ctx, method, path, body, length, false)
	if err != nil {
		return response{}, err
	}
	defer stop()
	defer resp.Body.Close()
	return decode(resp.Body)
}
func decode(r io.Reader) (response, error) {
	raw, err := io.ReadAll(io.LimitReader(r, 1<<20))
	if err != nil {
		return response{}, err
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err = json.Unmarshal(raw, &envelope); err != nil {
		return response{}, err
	}
	if len(envelope.Data) > 0 {
		raw = envelope.Data
	}
	var result response
	err = json.Unmarshal(raw, &result)
	if err == nil && result.Transfer.ID == "" {
		err = fmt.Errorf("invalid transfer metadata response")
	}
	return result, err
}

type activityReader struct {
	io.Reader
	touch func()
}

func (r *activityReader) Read(p []byte) (int, error) {
	n, e := r.Reader.Read(p)
	if n > 0 {
		r.touch()
	}
	return n, e
}

type activityBody struct {
	io.ReadCloser
	touch func()
}

func (r *activityBody) Read(p []byte) (int, error) {
	n, e := r.ReadCloser.Read(p)
	if n > 0 {
		r.touch()
	}
	return n, e
}

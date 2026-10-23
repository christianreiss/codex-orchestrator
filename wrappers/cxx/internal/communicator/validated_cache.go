package communicator

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/google/uuid"
)

const ValidatedCacheProtocol = 2
const validatedCacheLimit = 64 * 1024 * 1024

func StrictCache(cfg *config.Config) bool {
	return cfg != nil && cfg.Orchestrator.CommunicatorCacheProtocol == ValidatedCacheProtocol
}

type cacheResource struct {
	Path       []string `json:"path"`
	Revision   string   `json:"revision"`
	SHA256     string   `json:"sha256"`
	ValidUntil *string  `json:"valid_until"`
	Content    *[]byte  `json:"content,omitempty"`
}
type cacheRead struct {
	Protocol  int                        `json:"protocol"`
	RequestID string                     `json:"request_id"`
	Method    string                     `json:"method"`
	Path      string                     `json:"path"`
	Body      map[string]json.RawMessage `json:"body"`
	Headers   map[string]string          `json:"headers"`
	Known     map[string]string          `json:"known"`
}
type cacheReply struct {
	Protocol   int               `json:"protocol"`
	RequestID  string            `json:"request_id"`
	CheckedAt  time.Time         `json:"checked_at"`
	ValidForMS int64             `json:"valid_for_ms"`
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	Body       json.RawMessage   `json:"body"`
	Resources  []cacheResource   `json:"resources"`
}
type cachedBytes struct {
	raw     []byte
	sha     string
	expires time.Time
}
type cachedRead struct {
	sequence  uint64
	resources map[string]cachedBytes
}
type validatedRAM struct {
	mu                          sync.Mutex
	reads                       map[string]cachedRead
	gates                       map[string]*cacheReadGate
	sequence                    uint64
	size                        int
	hits, misses, confirmations uint64
}

type cacheReadGate struct {
	token chan struct{}
	refs  int
}

// Concurrent misses share the fetched bytes, but each waiter still obtains its
// own fresh confirmation after the first read has populated RAM.
func (c *validatedRAM) gate(ctx context.Context, key string) (func(), error) {
	c.mu.Lock()
	if c.gates == nil {
		c.gates = map[string]*cacheReadGate{}
	}
	gate := c.gates[key]
	if gate == nil {
		gate = &cacheReadGate{token: make(chan struct{}, 1)}
		c.gates[key] = gate
	}
	gate.refs++
	c.mu.Unlock()
	drop := func() {
		c.mu.Lock()
		gate.refs--
		if gate.refs == 0 {
			delete(c.gates, key)
		}
		c.mu.Unlock()
	}
	select {
	case gate.token <- struct{}{}:
		return func() { <-gate.token; drop() }, nil
	case <-ctx.Done():
		drop()
		return nil, ctx.Err()
	}
}

func cachePath(path []string) string { b, _ := json.Marshal(path); return string(b) }
func byteDigest(raw []byte) string   { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }

func cacheBefore(deadline time.Time) bool {
	now := time.Now()
	// Monotonic time defeats clock rollback; the wall deadline catches suspend
	// on systems whose monotonic clock pauses while the machine sleeps.
	return now.Before(deadline) && now.UnixNano() < deadline.UnixNano()
}

func cacheHeaders(headers map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range headers {
		key = strings.ToLower(key)
		switch key {
		case "authorization", "content-type", "accept", "user-agent", "x-engine", "x-agent-bridge-token", "x-agent-relay-token", "x-wrapper-version", "x-cxx-version", "x-wrapper-platform", "mcp-session-id", "mcp-protocol-version":
			out[key] = value
		}
	}
	return out
}

// The key retains credentials, engine, home, account and render hints. A fresh
// request's session/RPC IDs and disk digests are never part of the cached bytes.
func cacheKey(f frame, body map[string]json.RawMessage) string {
	stable := make(map[string]json.RawMessage, len(body))
	for key, value := range body {
		stable[key] = value
	}
	for _, key := range []string{"session_id", "auth_candidate", "digest", "auth_digest", "auth_sha", "agents", "config", "skills", "artifacts", "sha256"} {
		delete(stable, key)
	}
	if strings.Split(f.Path, "?")[0] == "/mcp" {
		delete(stable, "id")
	}
	raw, _ := json.Marshal(struct {
		Method, Path string
		Headers      map[string]string
		Body         map[string]json.RawMessage
	}{f.Method, f.Path, cacheHeaders(f.Headers), stable})
	return byteDigest(raw)
}

func (c *validatedRAM) snapshot(key string, now time.Time) (uint64, map[string]cachedBytes) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sequence++
	out := map[string]cachedBytes{}
	for path, value := range c.reads[key].resources {
		if value.expires.IsZero() || now.Before(value.expires) && now.UnixNano() < value.expires.UnixNano() {
			value.raw = bytes.Clone(value.raw)
			out[path] = value
		}
	}
	return c.sequence, out
}
func (c *validatedRAM) replace(key string, sequence uint64, resources map[string]cachedBytes, hits, misses uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.confirmations++
	c.hits += hits
	c.misses += misses
	if c.reads == nil {
		c.reads = map[string]cachedRead{}
	}
	if c.reads[key].sequence > sequence {
		return
	}
	// Bound both bytes and metadata. Clearing drops secrets and cannot authorize a read.
	if len(c.reads) >= 256 || c.size > validatedCacheLimit {
		c.reads = map[string]cachedRead{}
		c.size = 0
	}
	for _, value := range c.reads[key].resources {
		c.size -= len(value.raw)
	}
	size := 0
	for _, value := range resources {
		size += len(value.raw)
	}
	if size > validatedCacheLimit {
		delete(c.reads, key)
		return
	}
	if c.size+size > validatedCacheLimit {
		c.reads = map[string]cachedRead{}
		c.size = 0
	}
	c.reads[key] = cachedRead{sequence: sequence, resources: resources}
	c.size += size
}
func (c *validatedRAM) status() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return map[string]any{"protocol": ValidatedCacheProtocol, "bytes": c.size, "entries": len(c.reads), "hits": c.hits, "misses": c.misses, "confirmations": c.confirmations}
}

func cacheCandidate(f frame) bool {
	u, err := url.Parse(f.Path)
	if err != nil || !strings.HasPrefix(f.Path, "/") || strings.ContainsAny(f.Path, "%\\#") || strings.Contains(f.Path, "//") {
		return false
	}
	for key := range u.Query() {
		if key != "engine" {
			return false
		}
	}
	if f.Method == "GET" {
		return u.Path == "/skills" || strings.HasPrefix(u.Path, "/skills/")
	}
	if f.Method != "POST" {
		return false
	}
	var body map[string]json.RawMessage
	if json.Unmarshal(f.Body, &body) != nil {
		return false
	}
	switch u.Path {
	case "/sync/bootstrap", "/auth/sessions", "/agents/retrieve", "/config/retrieve", "/skills/retrieve":
		return true
	case "/auth":
		var command string
		return len(body["command"]) == 0 || json.Unmarshal(body["command"], &command) == nil && command == "retrieve"
	case "/mcp":
		var rpc struct {
			JSONRPC, Method string
			ID              json.RawMessage
			Params          struct {
				Name, URI string
				Arguments struct {
					URI string `json:"uri"`
				}
			}
		}
		if json.Unmarshal(f.Body, &rpc) != nil || rpc.JSONRPC != "2.0" || len(rpc.ID) == 0 || string(rpc.ID) == "null" {
			return false
		}
		if rpc.Method == "resources/read" {
			return strings.HasPrefix(rpc.Params.URI, "skill://")
		}
		return rpc.Method == "tools/call" && (rpc.Params.Name == "skill_list" || rpc.Params.Name == "skill_retrieve" || rpc.Params.Name == "resource_read" && strings.HasPrefix(rpc.Params.Arguments.URI, "skill://"))
	}
	return false
}

func putResource(node any, path []string, value json.RawMessage) error {
	if len(path) == 0 {
		return errors.New("invalid cache resource path")
	}
	for i, key := range path {
		last := i == len(path)-1
		switch obj := node.(type) {
		case map[string]any:
			child, ok := obj[key]
			if !ok {
				return errors.New("missing cache placeholder")
			}
			if last {
				if child != nil {
					return errors.New("occupied cache placeholder")
				}
				obj[key] = value
				return nil
			}
			node = child
		case []any:
			index, err := strconv.Atoi(key)
			if err != nil || index < 0 || index >= len(obj) {
				return errors.New("invalid cache array path")
			}
			if last {
				if obj[index] != nil {
					return errors.New("occupied cache placeholder")
				}
				obj[index] = value
				return nil
			}
			node = obj[index]
		default:
			return errors.New("invalid cache template")
		}
	}
	return errors.New("invalid cache resource path")
}

// Reconstruct only a reply correlated to THIS server confirmation. Cache entries
// alone never yield a response, including after a timeout, reconnect or expiry.
func (c *validatedRAM) read(ctx context.Context, f frame, exchange func(context.Context, frame) (frame, bool, error)) (result frame, unknown bool, err error) {
	confirmedOperation := false
	defer func() {
		// A valid server reply can be lost during proof reconstruction too.
		// Never invite a caller to replay a credential exchange or admission.
		if err != nil && confirmedOperation && (strings.Split(f.Path, "?")[0] == "/sync/bootstrap" || strings.Split(f.Path, "?")[0] == "/auth/sessions") {
			unknown = true
		}
	}()
	body := map[string]json.RawMessage{}
	if len(f.Body) > 0 && json.Unmarshal(f.Body, &body) != nil {
		return frame{}, false, errors.New("invalid cache request")
	}
	key := cacheKey(f, body)
	release, err := c.gate(ctx, key)
	if err != nil {
		return frame{}, false, err
	}
	defer release()
	started := time.Now()
	sequence, previous := c.snapshot(key, started)
	input := cacheRead{Protocol: ValidatedCacheProtocol, RequestID: uuid.NewString(), Method: f.Method, Path: f.Path, Body: body, Headers: cacheHeaders(f.Headers), Known: map[string]string{}}
	for path, resource := range previous {
		input.Known[path] = resource.sha
	}
	raw, _ := json.Marshal(input)
	result, unknown, err = exchange(ctx, frame{Method: "POST", Path: "/sync/cache", Headers: map[string]string{"content-type": "application/json"}, Body: raw})
	if err != nil || result.Status >= 400 {
		return result, unknown, err
	}
	confirmedOperation = true
	var envelope struct {
		Data cacheReply `json:"data"`
	}
	if json.Unmarshal(result.Body, &envelope) != nil {
		return frame{}, false, errors.New("invalid cache confirmation")
	}
	reply := envelope.Data
	if reply.Protocol != ValidatedCacheProtocol || reply.RequestID != input.RequestID || reply.CheckedAt.IsZero() || reply.ValidForMS <= 0 || reply.ValidForMS > 30_000 || reply.Status < 200 || reply.Status >= 300 {
		return frame{}, false, errors.New("unconfirmed cache response")
	}
	// Use the request's monotonic start, not the local wall clock. Network time
	// consumes the budget; a clock rollback cannot extend a confirmation.
	deadline := started.Add(time.Duration(reply.ValidForMS) * time.Millisecond)
	if !cacheBefore(deadline) {
		return frame{}, false, errors.New("cache confirmation expired")
	}
	var template any
	decoder := json.NewDecoder(bytes.NewReader(reply.Body))
	decoder.UseNumber()
	if decoder.Decode(&template) != nil {
		return frame{}, false, errors.New("invalid cache template")
	}
	resources := map[string]cachedBytes{}
	var hits, misses uint64
	for _, resource := range reply.Resources {
		path := cachePath(resource.Path)
		if _, duplicate := resources[path]; duplicate {
			return frame{}, false, errors.New("duplicate cache resource")
		}
		raw := []byte(nil)
		if resource.Content != nil {
			raw = bytes.Clone(*resource.Content)
			misses++
		} else {
			raw = previous[path].raw
			hits++
		}
		if !json.Valid(raw) || len(resource.SHA256) != 64 || resource.Revision != resource.SHA256 || byteDigest(raw) != resource.SHA256 {
			return frame{}, false, errors.New("cache resource digest mismatch")
		}
		expiry := time.Time{}
		if resource.ValidUntil != nil {
			absolute, err := time.Parse(time.RFC3339Nano, *resource.ValidUntil)
			if err != nil || !absolute.After(reply.CheckedAt) {
				return frame{}, false, errors.New("cache resource expired")
			}
			expiry = started.Add(absolute.Sub(reply.CheckedAt))
			if !cacheBefore(expiry) {
				return frame{}, false, errors.New("cache resource expired")
			}
			if expiry.Before(deadline) {
				deadline = expiry
			}
		}
		if err := putResource(template, resource.Path, json.RawMessage(raw)); err != nil {
			return frame{}, false, err
		}
		resources[path] = cachedBytes{raw: raw, sha: resource.SHA256, expires: expiry}
	}
	result.Body, err = json.Marshal(template)
	if err != nil {
		return frame{}, false, err
	}
	if !cacheBefore(deadline) {
		return frame{}, false, errors.New("cache confirmation expired")
	}
	c.replace(key, sequence, resources, hits, misses)
	result.Status, result.Headers = reply.Status, reply.Headers
	if result.Headers == nil {
		result.Headers = map[string]string{}
	}
	result.Headers["x-cxx-cache-protocol"] = "2"
	result.Headers["cache-control"] = "no-store"
	result.cacheDeadline = deadline
	return result, false, nil
}

func (s *server) cacheExchange(ctx context.Context, f frame) (frame, bool, error) {
	s.mu.Lock()
	fallback := s.fallback
	s.mu.Unlock()
	if !fallback {
		if connection := s.waitConnection(ctx); connection != nil {
			return connection.request(ctx, f)
		}
	}
	// A reachable HTTPS server can still give a fresh proof while WS reconnects.
	return cacheHTTPS(ctx, s.configSnapshot(), f)
}

func cacheHTTPS(ctx context.Context, cfg *config.Config, f frame) (frame, bool, error) {
	transport, err := directTransport(cfg)
	if err != nil {
		return frame{}, false, err
	}
	defer transport.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(cfg.Orchestrator.BaseURL, "/")+"/sync/cache", bytes.NewReader(f.Body))
	if err != nil {
		return frame{}, false, err
	}
	req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Transport: transport, Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		return frame{}, true, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 32*1024*1024+1))
	if len(raw) > 32*1024*1024 {
		return frame{}, true, fmt.Errorf("cache response too large")
	}
	return frame{Status: res.StatusCode, Body: raw}, true, err
}

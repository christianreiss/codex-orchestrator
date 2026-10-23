package communicator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// Match the existing proof response bound, above the native MCP input limit.
const cacheBridgeBodyLimit = 32 * 1024 * 1024

// Classification happens before dispatch, including for bodies without GetBody.
// Restore consumed bytes so writes outside the narrow cache allowlist retain
// their original body and execute through the owner exactly once.
func cacheRequestFrame(req *http.Request, path string) (frame, error) {
	f := frame{Method: req.Method, Path: path, Headers: map[string]string{}}
	for key, values := range req.Header {
		f.Headers[strings.ToLower(key)] = strings.Join(values, ", ")
	}
	if req.Method != "POST" {
		return f, nil
	}
	switch strings.Split(path, "?")[0] {
	case "/auth", "/auth/sessions", "/sync/bootstrap", "/agents/retrieve", "/config/retrieve", "/skills/retrieve", "/mcp":
	default:
		return f, nil
	}
	if req.Body == nil || req.Body == http.NoBody {
		return f, nil
	}
	body := req.Body
	restore := req.GetBody == nil
	if !restore {
		var err error
		body, err = req.GetBody()
		if err != nil {
			return frame{}, err
		}
	}
	raw, err := io.ReadAll(io.LimitReader(body, cacheBridgeBodyLimit+1))
	body.Close()
	if restore {
		req.Body = io.NopCloser(bytes.NewReader(raw))
	}
	if err != nil {
		return frame{}, err
	}
	if len(raw) > cacheBridgeBodyLimit {
		return frame{}, errors.New("cache request exceeds the supported body limit")
	}
	f.Body = raw
	return f, nil
}

// This bridge is the same verified protocol as the owner's RAM cache, carried
// directly over authenticated TLS while a legacy owner still has native leases.
// It is selected only before application dispatch, never after a missing receipt.
func (ep *endpoint) bridgeCache(req *http.Request, cfg *config.Config, source frame) *http.Response {
	if req.Body != nil {
		defer req.Body.Close()
	}
	result, unknown, err := ep.legacyCache.read(req.Context(), source, func(ctx context.Context, f frame) (frame, bool, error) {
		return cacheHTTPS(ctx, cfg, f)
	})
	if err != nil {
		return cacheBridgeFailure(req, unknown, err)
	}
	if !result.cacheDeadline.IsZero() && !cacheBefore(result.cacheDeadline) {
		return cacheBridgeFailure(req, req.Method == "POST", errors.New("cache confirmation expired"))
	}
	headers := http.Header{}
	for key, value := range result.Headers {
		headers.Set(key, value)
	}
	return &http.Response{StatusCode: result.Status, Header: headers, Body: responseBody(result.Body), ContentLength: int64(len(result.Body)), Request: req}
}

func cacheBridgeFailure(req *http.Request, unknown bool, cause error) *http.Response {
	status, code := http.StatusServiceUnavailable, "communicator_unavailable"
	message := code + ": " + oneLine(cause.Error(), 240)
	if unknown {
		status, code = http.StatusConflict, "communicator_outcome_unknown"
		message = code
	}
	body, _ := json.Marshal(map[string]any{"error": map[string]string{"code": code, "message": message}})
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}, "Cache-Control": []string{"no-store"}}, Body: responseBody(body), ContentLength: int64(len(body)), Request: req}
}

package communicator

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// mcpHealth is what forwarded managed MCP calls actually experienced. The
// control connection authenticates with the host key from the signed config,
// while each MCP frame carries the native client's own bearer (the host key or
// a host-bound MCP session token) and the server judges it per frame. A
// connected transport and a checked provider auth state therefore say nothing
// about whether MCP calls are accepted (feedback e099e458); this does.
type mcpHealth struct {
	lastOK     time.Time
	lastStatus int
	lastAt     time.Time
	failure    *mcpRejection
}

type mcpRejection struct {
	status int
	code   string
	at     time.Time
}

// note records one upstream answer to a forwarded /mcp frame. Only the HTTP
// status and a bounded machine code are kept, never a body or credential.
func (h *mcpHealth) note(status int, body []byte, now time.Time) {
	if status < 100 {
		return
	}
	h.lastStatus, h.lastAt = status, now
	if status < 400 {
		h.lastOK = now
		return
	}
	h.failure = &mcpRejection{status: status, code: upstreamErrorCode(body), at: now}
}

// state is "unknown" before the first forwarded call, "unauthorized" while the
// newest answer was 401/403, "failing" for another error status, else "ok".
func (h *mcpHealth) state() string {
	switch {
	case h.lastAt.IsZero():
		return "unknown"
	case h.lastStatus == http.StatusUnauthorized || h.lastStatus == http.StatusForbidden:
		return "unauthorized"
	case h.lastStatus >= 400:
		return "failing"
	}
	return "ok"
}

func (h *mcpHealth) view() map[string]any {
	view := map[string]any{"state": h.state()}
	if !h.lastAt.IsZero() {
		view["last_status"] = h.lastStatus
		view["last_at"] = h.lastAt.UTC().Format(time.RFC3339)
	}
	if !h.lastOK.IsZero() {
		view["last_ok_at"] = h.lastOK.UTC().Format(time.RFC3339)
	}
	if h.failure != nil {
		failure := map[string]any{"status": h.failure.status, "at": h.failure.at.UTC().Format(time.RFC3339)}
		if h.failure.code != "" {
			failure["code"] = h.failure.code
		}
		view["last_failure"] = failure
	}
	return view
}

func (s *server) noteMCPResult(status int, body []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mcp.note(status, body, time.Now())
}

// upstreamErrorCode extracts the server's machine code ("code" or
// "error.code") and drops anything that is not a short snake/kebab/dotted
// identifier, so neither status output nor a model-facing failure can carry
// upstream text.
func upstreamErrorCode(body []byte) string {
	var failure struct {
		Code  string `json:"code"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &failure)
	code := failure.Code
	if code == "" {
		code = failure.Error.Code
	}
	if len(code) > 128 || strings.IndexFunc(code, func(r rune) bool {
		return r != '_' && r != '-' && r != '.' && (r < 'a' || r > 'z') && (r < '0' || r > '9')
	}) >= 0 {
		return ""
	}
	return code
}

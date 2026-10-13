package communicator

import (
	"net/http"
	"regexp"
	"strings"
)

// Keep the managed route inventory aligned with communicatorPathAllowed in the
// API. HTTPS transfers additionally carry the existing watchdog stream.
var managedRoutes = regexp.MustCompile(`^(?:/auth(?:/sessions(?:/(?:heartbeat|release))?)?|/versions|/skills(?:/[^?]*)?|/agents/retrieve|/config/retrieve|/sync/(?:bootstrap|status)|/cron/(?:check|report)|/mcp(?:/[^?]*)?|/host/[^?]+|/wrapper/(?:v2/)?[^?]+|/claude/usage/report)$`)

// requestPath is the pathname the API router dispatches: no query and no
// trailing slash. Fastify runs with ignoreTrailingSlash. The raw escaped path
// is checked first so a leading "//" or an encoded segment is rejected before
// the slash trim.
func requestPath(r *http.Request) string {
	path := r.URL.EscapedPath()
	if len(path) > 1 {
		path = strings.TrimRight(path, "/")
	}
	return path
}

func managedRequestAllowed(r *http.Request) bool {
	raw := r.URL.EscapedPath()
	if !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || strings.ContainsAny(raw, "%\\#\r\n") {
		return false
	}
	path := requestPath(r)
	if strings.HasPrefix(path, "/host/communicator") || strings.HasSuffix(path, "/connect") {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == "." || part == ".." {
			return false
		}
	}
	if strings.HasSuffix(path, "/stream") {
		return strings.HasPrefix(path, "/host/agent-sessions/") && strings.HasSuffix(path, "/watchdog/stream")
	}
	return managedRoutes.MatchString(path)
}

func transferHeaders(r *http.Request, hostKey string) http.Header {
	h := make(http.Header)
	for _, name := range []string{"content-type", "accept", "user-agent", "x-engine", "x-agent-bridge-token", "x-agent-relay-token", "x-wrapper-platform", "x-wrapper-version", "x-cxx-version", "if-none-match", "mcp-session-id", "mcp-protocol-version", "last-event-id", "range"} {
		if value := r.Header.Get(name); value != "" {
			h.Set(name, value)
		}
	}
	h.Set("X-API-Key", hostKey)
	if requestPath(r) == "/mcp" {
		h.Set("Authorization", r.Header.Get("Authorization"))
		// The MCP route checks that the bearer belongs to this host, including
		// when a large MCP upload travels outside the bounded WebSocket frames.
		h.Set("X-Cxx-Communicator", "1")
	}
	return h
}

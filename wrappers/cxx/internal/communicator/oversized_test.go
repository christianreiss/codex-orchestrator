package communicator

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

func TestOversizedCompletedWritesAreNeverReplayed(t *testing.T) {
	for _, test := range []struct{ name, method, path, body string }{
		{"auth bootstrap", "POST", "/sync/bootstrap", `{"include_auth":true}`},
		{"bootstrap candidate", "POST", "/sync/bootstrap", `{"include_auth":false,"auth_candidate":{"tokens":{}}}`},
		{"bootstrap session", "POST", "/sync/bootstrap/", `{"include_auth":false,"session_id":"native-session"}`},
		{"implicit bootstrap auth", "POST", "/sync/bootstrap", `{}`},
		{"auth store", "POST", "/auth", `{"command":"store"}`},
		{"MCP tool call", "POST", "/mcp", `{"method":"tools/call"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			var controlCalls, transferCalls atomic.Int32
			c := testConnection(t, func(ws *websocket.Conn, f frame) {
				controlCalls.Add(1)
				_ = websocket.JSON.Send(ws, frame{ID: f.ID, Status: 502, Body: []byte(`{"code":"communicator_response_too_large"}`)})
			})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				transferCalls.Add(1)
				w.WriteHeader(200)
			}))
			defer upstream.Close()
			s := &server{conn: c, calls: map[string]*sharedCall{}, cfg: &config.Config{Orchestrator: config.Orchestrator{BaseURL: upstream.URL}}}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, httptest.NewRequest(test.method, test.path, strings.NewReader(test.body)))
			if w.Code != 409 || !strings.Contains(w.Body.String(), "communicator_outcome_unknown") || controlCalls.Load() != 1 || transferCalls.Load() != 0 {
				t.Fatalf("completed write invited replay: status=%d body=%s control=%d HTTPS=%d", w.Code, w.Body.String(), controlCalls.Load(), transferCalls.Load())
			}
		})
	}
}

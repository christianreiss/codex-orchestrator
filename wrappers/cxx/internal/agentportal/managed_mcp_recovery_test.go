package agentportal

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestManagedMCPExpiryRepairsNextCallWithoutReplayingMutation(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			var calls, registrations, writes atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/host/agent-sessions" {
					registrations.Add(1)
					writeRenewal(w)
					return
				}
				calls.Add(1)
				writes.Add(1) // Simulate mutation committed before response proof expired.
				if calls.Load() == 1 {
					w.WriteHeader(401)
					fmt.Fprint(w, `{"error":{"code":"agent_bridge_expired"}}`)
					return
				}
				fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":{}}`)
			}))
			defer remote.Close()
			session := recoverySession(engine, remote.URL, remote.Client())
			b := &Broker{ctx: context.Background(), session: session}
			call := func() int {
				w := httptest.NewRecorder()
				b.ServeHTTP(w, httptest.NewRequest("POST", "/_mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write"}}`)))
				return w.Code
			}
			if got := call(); got != 401 {
				t.Fatal(got)
			}
			if calls.Load() != 1 || writes.Load() != 1 || registrations.Load() != 1 {
				t.Fatalf("expired call replayed or not repaired: calls=%d writes=%d registrations=%d", calls.Load(), writes.Load(), registrations.Load())
			}
			if got := call(); got != 200 {
				t.Fatal(got)
			}
			if calls.Load() != 2 || registrations.Load() != 1 {
				t.Fatal("next explicit call did not use repaired registration")
			}
		})
	}
}

func TestManagedMCPNeverRecoversOrReplaysUnknownOrTerminalResponses(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"terminal", 401, `{"code":"agent_bridge_unauthorized"}`},
		{"unknown", 409, `{"error":{"code":"communicator_outcome_unknown"}}`},
		{"wrong_status", 502, `{"code":"agent_bridge_expired"}`},
		{"tool_error", 200, `{"jsonrpc":"2.0","error":{"code":"agent_bridge_expired"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer remote.Close()
			b := &Broker{ctx: context.Background(), session: recoverySession("codex", remote.URL, remote.Client())}
			w := httptest.NewRecorder()
			b.ServeHTTP(w, httptest.NewRequest("POST", "/_mcp", strings.NewReader(`{}`)))
			if calls.Load() != 1 || w.Code != tc.status || w.Body.String() != tc.body {
				t.Fatalf("opaque outcome changed: calls=%d response=%d %s", calls.Load(), w.Code, w.Body.String())
			}
		})
	}
}

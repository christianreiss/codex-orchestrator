package agentportal

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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

func TestManagedMCPRejectsInactiveSessionsWithoutUpstream(t *testing.T) {
	for _, state := range []string{"closing", "finished", "terminal"} {
		t.Run(state, func(t *testing.T) {
			var calls atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
			defer remote.Close()
			session := recoverySession("codex", remote.URL, remote.Client())
			switch state {
			case "closing":
				session.closing = true
			case "finished":
				session.finished = true
			case "terminal":
				session.terminalErr = sessionFinishedError()
			}
			b := &Broker{ctx: context.Background(), session: session}
			for range 2 {
				w := httptest.NewRecorder()
				b.ServeHTTP(w, httptest.NewRequest("POST", "/_mcp", strings.NewReader(`{}`)))
				if w.Code != 409 {
					t.Fatalf("inactive request not rejected: %d", w.Code)
				}
			}
			if calls.Load() != 0 {
				t.Fatal("inactive session contacted upstream")
			}
		})
	}
}

func TestManagedMCPTerminalRenewalStopsRepeatedAndConcurrentRecovery(t *testing.T) {
	for _, concurrency := range []int32{1, 8} {
		t.Run(fmt.Sprintf("callers_%d", concurrency), func(t *testing.T) {
			var calls, registrations atomic.Int32
			allEntered := make(chan struct{})
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/host/agent-sessions" {
					registrations.Add(1)
					w.WriteHeader(409)
					fmt.Fprint(w, `{"code":"agent_session_finished"}`)
					return
				}
				if calls.Add(1) == concurrency {
					close(allEntered)
				}
				<-allEntered
				w.WriteHeader(401)
				fmt.Fprint(w, `{"code":"agent_bridge_expired"}`)
			}))
			defer remote.Close()
			session := recoverySession("codex", remote.URL, remote.Client())
			b := &Broker{ctx: context.Background(), session: session}
			var wg sync.WaitGroup
			for range concurrency {
				wg.Add(1)
				go func() {
					defer wg.Done()
					w := httptest.NewRecorder()
					b.ServeHTTP(w, httptest.NewRequest("POST", "/_mcp", strings.NewReader(`{}`)))
				}()
			}
			wg.Wait()
			for range 3 {
				w := httptest.NewRecorder()
				b.ServeHTTP(w, httptest.NewRequest("POST", "/_mcp", strings.NewReader(`{}`)))
				if w.Code != 409 {
					t.Fatalf("terminal verdict was not retained: %d", w.Code)
				}
			}
			if registrations.Load() != 1 || calls.Load() != concurrency {
				t.Fatalf("terminal renewal repeated or MCP replayed: registrations=%d calls=%d", registrations.Load(), calls.Load())
			}
			if !session.isInactive() {
				t.Fatal("terminal renewal did not deactivate session")
			}
		})
	}
}

func TestConcurrentBridgeCancellationRetainsTerminalReason(t *testing.T) {
	started := make(chan struct{})
	var calls atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if calls.Add(1) == 1 {
			close(started)
			<-r.Context().Done()
			return nil, r.Context().Err()
		}
		return responseFor(r, 403, `{"code":"agent_bridge_host_mismatch"}`), nil
	})}
	session := recoverySession("codex", "http://portal.invalid", client)
	canceled := make(chan error, 1)
	go func() { canceled <- session.Heartbeat(context.Background(), "", "") }()
	<-started
	if err := session.Heartbeat(context.Background(), "", ""); !portalErrorCode(err, "agent_bridge_host_mismatch") {
		t.Fatal(err)
	}
	select {
	case err := <-canceled:
		if !portalErrorCode(err, "agent_bridge_host_mismatch") {
			t.Fatalf("terminal reason lost to sibling cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("sibling request was not canceled")
	}
}

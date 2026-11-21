package agentportal

import (
	"context"
	"encoding/json"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/testhome"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

func TestConnectionStateSuppressesSessionAndClaimRenewals(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "state.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var open communicator.StateFrame
		if websocket.JSON.Receive(ws, &open) != nil {
			return
		}
		frame := communicator.StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: uuid.NewString(), Revision: "1", Payload: json.RawMessage(`{"ownership_mode":"connection","authorization_deadline":null,"session":{},"receiver":null,"native_control":null,"watchdog":null,"schedule":null}`)}
		if websocket.JSON.Send(ws, frame) != nil {
			return
		}
		for {
			var f communicator.StateFrame
			if websocket.JSON.Receive(ws, &f) != nil {
				return
			}
		}
	})}
	go server.Serve(listener)
	defer server.Close()
	original := dialPortalState
	defer func() { dialPortalState = original }()
	dialPortalState = func(ctx context.Context, _ string, scope communicator.StateScope, auth communicator.StateAuth) (*communicator.StateClient, error) {
		return communicator.DialStateSocket(ctx, socket, "/state", scope, auth)
	}
	var requests atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); w.Write([]byte(`{}`)) }))
	defer api.Close()
	session := &Session{ID: uuid.NewString(), BridgeToken: "fixture", BaseURL: api.URL, http: api.Client(), activeClaims: map[string]bool{uuid.NewString(): true}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := session.startHeartbeat(ctx, 10*time.Millisecond)
	defer stop()
	select {
	case <-session.stateNegotiated():
	case <-time.After(time.Second):
		t.Fatal("snapshot not negotiated")
	}
	time.Sleep(60 * time.Millisecond)
	session.renewActiveClaims(ctx)
	if requests.Load() != 0 {
		t.Fatalf("unchanged live state emitted %d requests", requests.Load())
	}
	_, _, live, used := session.stateView()
	if !live || !used {
		t.Fatal("confirmed state missing")
	}
	cancel()
	stop()
	_, _, live, used = session.stateView()
	if live || !used {
		t.Fatal("disconnect retained authority or restored legacy mode")
	}
}

func TestPendingAdmissionRecoversBeforeRequiredStateAndKeepsIdentity(t *testing.T) {
	testhome.Isolate(t)
	socket := filepath.Join(t.TempDir(), "state.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var open communicator.StateFrame
		if websocket.JSON.Receive(ws, &open) != nil {
			return
		}
		if open.Scope.Engine != "codex" {
			t.Errorf("engine missing: %+v", open.Scope)
		}
		frame := communicator.StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: uuid.NewString(), Revision: "1", Payload: json.RawMessage(`{"ownership_mode":"connection","authorization_deadline":null,"session":{}}`)}
		if websocket.JSON.Send(ws, frame) != nil {
			return
		}
		for {
			var f communicator.StateFrame
			if websocket.JSON.Receive(ws, &f) != nil {
				return
			}
		}
	})}
	go server.Serve(listener)
	defer server.Close()
	original := dialPortalState
	defer func() { dialPortalState = original }()
	dialPortalState = func(ctx context.Context, _ string, scope communicator.StateScope, auth communicator.StateAuth) (*communicator.StateClient, error) {
		return communicator.DialStateSocket(ctx, socket, "/state", scope, auth)
	}
	var registrations atomic.Int32
	var sessionID, token string
	const address = "12345678-1234-4123-8123-123456789abc"
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/host/agent-sessions" {
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			id, bridge := body["session_id"].(string), body["bridge_token"].(string)
			// Start's attempts are sequential; later recovery is single-flight.
			if registrations.Add(1) == 1 {
				sessionID, token = id, bridge
			}
			if id != sessionID || bridge != token {
				t.Error("recovery replaced launch identity")
			}
			if registrations.Load() <= 2 {
				w.WriteHeader(503)
				w.Write([]byte(`{}`))
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"enabled": true, "session_id": id, "bridge_token": bridge, "agent_address": map[string]any{"name": "Jutta", "address": "agent:" + address}})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/self") {
			json.NewEncoder(w).Encode(Identity{Version: 1, SessionID: sessionID, Engine: "codex", Name: "Jutta", UUID: address, Address: "agent:" + address})
			return
		}
		w.Write([]byte(`{}`))
	}))
	defer api.Close()
	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: api.URL, APIKey: "fixture", CommunicatorStateProtocol: 1}, AgentMessaging: config.AgentMessaging{Enabled: true}}
	runtime, startErr := StartConnection(context.Background(), cfg, StartInput{Engine: "codex"})
	if startErr == nil {
		t.Fatal("expected pending admission")
	}
	defer runtime.Close("completed", "test")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	identity, err := runtime.RequireIdentity(ctx, cfg)
	if err != nil {
		t.Fatalf("pending admission failed to attach promptly: %v", err)
	}
	if identity.Name != "Jutta" || identity.SessionID != sessionID || registrations.Load() != 3 {
		t.Fatalf("identity=%+v registrations=%d", identity, registrations.Load())
	}
}

func serveStateSocket(t *testing.T, handler http.Handler) string {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "state.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	go server.Serve(ln)
	t.Cleanup(func() { server.Close() })
	return socket
}

func TestReceiverBrokerNegotiatesRenewalPerClient(t *testing.T) {
	for _, tc := range []struct {
		name                string
		optIn, modernServer bool
	}{
		{"opt_in", true, true}, {"legacy_client", false, true}, {"legacy_server", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			owner := serveStateSocket(t, websocket.Handler(func(ws *websocket.Conn) {
				defer ws.Close()
				var open communicator.StateFrame
				if websocket.JSON.Receive(ws, &open) != nil {
					return
				}
				if open.RequestsAuthorizationRefresh() != tc.optIn || open.Scope.SessionID != "trusted-session" || open.Scope.Engine != "codex" || open.Scope.RelayID != "" || open.Auth.BridgeToken != "fixture-token" {
					t.Errorf("broker changed negotiation or failed to bind session credentials")
					return
				}
				root := communicator.StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: uuid.NewString(), Revision: "1", Payload: json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:00Z","authorization_deadline":"2000-01-01T00:00:10Z","receiver":"ready"}`)}
				if websocket.JSON.Send(ws, root) != nil {
					return
				}
				for {
					var in communicator.StateFrame
					if websocket.JSON.Receive(ws, &in) != nil {
						return
					}
					if in.Type != "state_update" {
						continue
					}
					switch string(in.Payload) {
					case `"renew"`:
						f := root
						if tc.modernServer && tc.optIn {
							f.Type = "state_ping"
							f.Payload = json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:01Z","authorization_deadline":"2000-01-01T00:01:00Z"}`)
						} else {
							f.Type = "state_delta"
							f.Revision = "2"
							f.Payload = json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:01Z","authorization_deadline":"2000-01-01T00:01:00Z","receiver":"ready"}`)
						}
						if websocket.JSON.Send(ws, f) != nil {
							return
						}
					case `"revoke"`:
						websocket.JSON.Send(ws, communicator.StateFrame{Type: "state_close", Protocol: 1, StreamID: root.StreamID, OwnerEpoch: root.OwnerEpoch, Code: "authorization_revoked"})
						return
					default:
						t.Errorf("unexpected state update")
					}
				}
			}))
			original := dialReceiverState
			dialReceiverState = func(sub communicator.StateSubscription, ctx context.Context, _ string, scope communicator.StateScope, auth communicator.StateAuth) (*communicator.StateClient, error) {
				return sub.DialSocket(ctx, owner, "/state", scope, auth)
			}
			defer func() { dialReceiverState = original }()
			b := &Broker{session: &Session{ID: "trusted-session", Engine: "codex", BridgeToken: "fixture-token", receiverAllowed: true}}
			local := serveStateSocket(t, http.HandlerFunc(b.stateStream))
			scope := communicator.StateScope{Topic: "receiver", Engine: "grok", SessionID: "ignored", RelayID: "ignored"}
			c, err := (communicator.StateSubscription{AuthorizationRefresh: tc.optIn}).DialSocket(context.Background(), local, "/_state", scope, communicator.StateAuth{})
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			first, change, live := c.Snapshot(nil)
			deadline := c.AuthorizationDeadline()
			if !live || first.Auth != nil {
				t.Fatal("receiver snapshot invalid")
			}
			if err := c.Update("renew"); err != nil {
				t.Fatal(err)
			}
			until := time.Now().Add(time.Second)
			for !c.AuthorizationDeadline().After(deadline) && time.Now().Before(until) {
				time.Sleep(time.Millisecond)
			}
			if !c.AuthorizationDeadline().After(deadline) {
				t.Fatal("receiver missed renewal")
			}
			got, _, live := c.Snapshot(nil)
			if !live {
				t.Fatal("receiver lost authority")
			}
			if tc.optIn && tc.modernServer {
				select {
				case <-change:
					t.Fatal("broker woke receiver on same-revision refresh")
				default:
				}
				if got.Revision != first.Revision || string(got.Payload) != string(first.Payload) {
					t.Fatal("broker replaced snapshot")
				}
			} else {
				select {
				case <-change:
				default:
					t.Fatal("legacy delta did not reach receiver")
				}
				if got.Revision != "2" {
					t.Fatal("legacy revision missing")
				}
			}
			if err := c.Update("revoke"); err != nil {
				t.Fatal(err)
			}
			select {
			case <-c.Done():
			case <-time.After(time.Second):
				t.Fatal("revocation did not close receiver")
			}
		})
	}
}

func TestSessionAuthorizationRefreshOutlivesOriginalDeadline(t *testing.T) {
	renew := make(chan struct{}, 1)
	defer close(renew)
	socket := serveStateSocket(t, websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var open communicator.StateFrame
		if websocket.JSON.Receive(ws, &open) != nil {
			return
		}
		f := communicator.StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: uuid.NewString(), Revision: "1", Payload: json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:00Z","authorization_deadline":"2000-01-01T00:00:00.500Z","session":{},"watchdog":{"binding_generation":7}}`)}
		if websocket.JSON.Send(ws, f) != nil {
			return
		}
		var ack communicator.StateFrame
		if websocket.JSON.Receive(ws, &ack) != nil {
			return
		}
		<-renew
		f.Type = "state_ping"
		f.Payload = json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:00.001Z","authorization_deadline":"2000-01-01T00:00:10Z"}`)
		if websocket.JSON.Send(ws, f) != nil {
			return
		}
		for websocket.JSON.Receive(ws, &ack) == nil {
		}
	}))
	original := dialPortalState
	dialPortalState = func(ctx context.Context, _ string, scope communicator.StateScope, auth communicator.StateAuth) (*communicator.StateClient, error) {
		return communicator.DialStateSocket(ctx, socket, "/state", scope, auth)
	}
	defer func() { dialPortalState = original }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &Session{ID: uuid.NewString(), Engine: "codex", BridgeToken: "fixture", watchdog: &watchdogFeed{}}
	done := make(chan error, 1)
	go func() { done <- s.consumeState(ctx) }()
	select {
	case <-s.stateNegotiated():
	case <-time.After(time.Second):
		t.Fatal("session negotiation failed")
	}
	observed := func() time.Time {
		s.watchdog.mu.Lock()
		defer s.watchdog.mu.Unlock()
		return s.watchdog.received
	}
	until := time.Now().Add(time.Second)
	for observed().IsZero() && time.Now().Before(until) {
		time.Sleep(time.Millisecond)
	}
	initial := observed()
	if initial.IsZero() {
		t.Fatal("watchdog snapshot missing")
	}
	renew <- struct{}{}
	select {
	case err := <-done:
		t.Fatalf("session ended at its obsolete deadline: %v", err)
	case <-time.After(550 * time.Millisecond):
	}
	if !initial.Equal(observed()) {
		t.Fatal("authorization renewal reapplied watchdog state")
	}
	_, _, live, used := s.stateView()
	if !live || !used {
		t.Fatal("session lost live authority")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("session failed to close")
	}
}

package agentportal

import (
	"context"
	"encoding/json"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
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

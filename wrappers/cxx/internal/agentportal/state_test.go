package agentportal

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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

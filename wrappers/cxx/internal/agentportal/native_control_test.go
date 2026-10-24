//go:build linux

package agentportal

import (
	"context"
	"encoding/json"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/google/uuid"
	"golang.org/x/net/websocket"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeprocess"
)

func TestNativeControlRoundTripForEveryEngine(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			var exits atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("x-agent-bridge-token") != "fixture-token" {
					t.Error("missing session authentication")
				}
				var body struct {
					Instance string `json:"instance_id"`
					Report   *struct {
						Status string `json:"status"`
					} `json:"report"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				if body.Report != nil && body.Report.Status == "exited" {
					exits.Add(1)
				}
				json.NewEncoder(w).Encode(map[string]any{"instance_id": body.Instance, "request_id": "11111111-1111-4111-8111-111111111111"})
			}))
			defer server.Close()
			session := &Session{ID: "22222222-2222-4222-8222-222222222222", BridgeToken: "fixture-token", BaseURL: server.URL, Engine: engine, http: server.Client()}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			ctx = session.withNativeControl(ctx)
			cmd := exec.CommandContext(ctx, "sleep", "30")
			supervisor := nativeprocess.Prepare(ctx, cmd, true)
			defer supervisor.Close()
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			supervisor.StartControl()
			_ = cmd.Wait()
			supervisor.Close()
			if ctx.Err() == nil {
				t.Fatal("operator stop did not cancel launch retries")
			}
			if exits.Load() != 1 {
				t.Fatalf("exit receipts: %d", exits.Load())
			}
		})
	}
}

func TestNativeControlStatePushStopsWithoutPolling(t *testing.T) {
	oldDial, oldAvailable := dialPortalState, portalStateAvailable
	defer func() { dialPortalState = oldDial; portalStateAvailable = oldAvailable }()
	portalStateAvailable = func(context.Context, string) bool { return true }
	socket := filepath.Join(t.TempDir(), "state.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	commands := make(chan struct{}, 1)
	attached := make(chan struct{}, 1)
	streamServer := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var open communicator.StateFrame
		if websocket.JSON.Receive(ws, &open) != nil {
			return
		}
		payload, _ := json.Marshal(map[string]any{"ownership_mode": "connection", "native_control": map[string]any{"instance_id": open.Scope.NativeInstanceID, "request_id": nil}})
		frame := communicator.StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: uuid.NewString(), Revision: "1", Payload: payload}
		if websocket.JSON.Send(ws, frame) != nil {
			return
		}
		attached <- struct{}{}
		<-commands
		payload, _ = json.Marshal(map[string]any{"ownership_mode": "connection", "native_control": map[string]any{"instance_id": open.Scope.NativeInstanceID, "request_id": "11111111-1111-4111-8111-111111111111"}})
		frame.Type = "state_delta"
		frame.Revision = "2"
		frame.Payload = payload
		websocket.JSON.Send(ws, frame)
		for {
			var f communicator.StateFrame
			if websocket.JSON.Receive(ws, &f) != nil {
				return
			}
		}
	})}
	go streamServer.Serve(listener)
	defer streamServer.Close()
	dialPortalState = func(ctx context.Context, _ string, scope communicator.StateScope, auth communicator.StateAuth) (*communicator.StateClient, error) {
		return communicator.DialStateSocket(ctx, socket, "/state", scope, auth)
	}
	var calls, exits atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body struct {
			Instance string `json:"instance_id"`
			Report   *struct {
				Status string `json:"status"`
			} `json:"report"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.Report != nil && body.Report.Status == "exited" {
			exits.Add(1)
		}
		json.NewEncoder(w).Encode(map[string]any{"instance_id": body.Instance, "request_id": nil})
	}))
	defer api.Close()
	session := &Session{ID: uuid.NewString(), BridgeToken: "fixture", BaseURL: api.URL, http: api.Client()}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ctx = session.withNativeControl(ctx)
	cmd := exec.CommandContext(ctx, "sleep", "30")
	supervisor := nativeprocess.Prepare(ctx, cmd, true)
	defer supervisor.Close()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	supervisor.StartControl()
	select {
	case <-attached:
	case <-ctx.Done():
		t.Fatal("state attachment missing")
	}
	time.Sleep(40 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("empty native control polled %d times", calls.Load())
	}
	commands <- struct{}{}
	_ = cmd.Wait()
	supervisor.Close()
	if exits.Load() != 1 {
		t.Fatalf("durable exit receipts=%d", exits.Load())
	}
}

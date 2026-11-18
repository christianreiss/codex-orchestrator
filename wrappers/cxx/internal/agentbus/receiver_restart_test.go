package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

// Unlike the legacy HTTP fixture below, this exercises run's own reconnect
// loop and the connection-owned protocol: the old state socket closes and a
// replacement owner sends a fresh epoch. No model-side listen/wait is allowed.
// The API/queue are simulated; this does not test SQL hydration or native Claude.
func TestClaudeReceiverAutomaticallyRecoversQueuedMessageAcrossOwnerRestart(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	t.Setenv(envSocket, "")
	socket := filepath.Join(t.TempDir(), "state.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	dropOwner := make(chan struct{})
	var connections atomic.Int32
	epochs := []string{uuid.NewString(), uuid.NewString()}
	stateServer := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var open communicator.StateFrame
		if websocket.JSON.Receive(ws, &open) != nil {
			return
		}
		first := connections.Add(1) == 1
		epoch := epochs[1]
		if first {
			epoch = epochs[0]
		}
		frame := communicator.StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: epoch, Revision: "1",
			Payload: json.RawMessage(`{"ownership_mode":"connection","work_revision":"1","sources":["peer"]}`)}
		if websocket.JSON.Send(ws, frame) != nil {
			return
		}
		readDone := make(chan struct{})
		go func() {
			defer close(readDone)
			for {
				var received communicator.StateFrame
				if websocket.JSON.Receive(ws, &received) != nil {
					return
				}
			}
		}()
		if first {
			select {
			case <-dropOwner:
			case <-readDone:
			}
		} else {
			<-readDone
		}
	})}
	go stateServer.Serve(listener)
	defer stateServer.Close()

	var mu sync.Mutex
	var outage, queued bool
	initialClaim := make(chan struct{}, 1)
	failedReconnect := make(chan struct{}, 1)
	var delivered atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if outage {
			http.Error(w, "API restarting", http.StatusBadGateway)
			if op := path.Base(req.URL.Path); op == "native" || op == "register" {
				select {
				case failedReconnect <- struct{}{}:
				default:
				}
			}
			return
		}
		out := map[string]any{}
		switch path.Base(req.URL.Path) {
		case "native":
			out["native_session_id"] = "same-native"
		case "register":
			out["sources"] = []string{"peer"}
			out["capabilities"] = map[string]any{"control_state_protocol": 1}
		case "heartbeat":
			t.Error("connection-owned receiver used the legacy heartbeat fallback")
		case "claim":
			if queued {
				queued = false
				out["delivery"] = map[string]any{"message_id": "queued-before-restart", "kind": "message", "content": "waiting peer message"}
			} else {
				select {
				case initialClaim <- struct{}{}:
				default:
				}
			}
		case "ack":
			out["message"] = map[string]any{"status": "accepted"}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer api.Close()
	c := &sessionClient{id: "original-session", socket: socket, http: &http.Client{Transport: rewriteTransport{api}}}
	r := &autoReceiver{client: c, tracker: newChannelTracker(c)}
	r.tracker.receiver = r
	r.output = &mcpWriter{w: receiverHealthWriter{r: r, deliveries: &delivered}}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	done := make(chan struct{})
	go func() { defer close(done); r.run(ctx, io.Discard) }()
	defer func() { cancel(); <-done }()
	select {
	case <-initialClaim:
	case <-ctx.Done():
		t.Fatal("initial owner never became ready")
	}
	// Atomically enqueue and stop admitting claims before dropping the owner.
	mu.Lock()
	queued, outage = true, true
	mu.Unlock()
	close(dropOwner)
	deadline := time.Now().Add(3 * time.Second)
	for r.health()["state"] != "unavailable" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if r.health()["state"] != "unavailable" || delivered.Load() != 0 {
		t.Fatal("owner disconnect was not observed before recovery")
	}
	// A socket close alone is insufficient: the first reconnect must fail,
	// then run must keep retrying without any model-side nudge.
	select {
	case <-failedReconnect:
	case <-ctx.Done():
		t.Fatal("receiver never attempted native binding/registration during the API outage")
	}
	mu.Lock()
	outage = false
	mu.Unlock()
	for delivered.Load() == 0 && ctx.Err() == nil {
		time.Sleep(time.Millisecond)
	}
	ready := r.health()["state"] == "ready"
	cancel()
	<-done
	if delivered.Load() != 1 || connections.Load() < 2 {
		t.Fatalf("automatic recovery: deliveries=%d state_connections=%d", delivered.Load(), connections.Load())
	}
	if !ready || r.boundNativeID != "same-native" || c.id != "original-session" {
		t.Fatal("recovery failed readiness or replaced the native/session binding")
	}
	if r.tracker.get("queued-before-restart") == nil {
		t.Fatal("recovery lost the original delivery correlation")
	}
}

func TestClaudeReceivesPeerInvitationAfterAPIOutage(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	t.Setenv(envSocket, "")
	var outage atomic.Bool
	outage.Store(true)
	var claimed atomic.Bool
	var delivered atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var args map[string]any
		_ = json.NewDecoder(req.Body).Decode(&args)
		out := map[string]any{}
		switch path.Base(req.URL.Path) {
		case "native":
			out["native_session_id"] = "same-native"
		case "register":
			out["sources"] = []string{"peer", "portal"}
		case "heartbeat":
			if outage.Load() {
				http.Error(w, "API restarting", 502)
				return
			}
		case "claim":
			if args["source"] == "peer" && claimed.CompareAndSwap(false, true) {
				out["delivery"] = map[string]any{"message_id": "invitation", "kind": "message", "content": "Incoming call invitation"}
			}
		case "ack":
			out["message"] = map[string]any{"status": "accepted"}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer server.Close()
	c := &sessionClient{id: "original-session", http: &http.Client{Transport: rewriteTransport{server}}}
	r := &autoReceiver{client: c, tracker: newChannelTracker(c)}
	r.output = &mcpWriter{w: receiverHealthWriter{r: r, deliveries: &delivered}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := r.connection(ctx); err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("outage not observed: %v", err)
	}
	if r.health()["state"] != "unavailable" || delivered.Load() != 0 {
		t.Fatal("outage advertised healthy or injected a probe")
	}
	outage.Store(false)
	done := make(chan error, 1)
	go func() { done <- r.connection(ctx) }()
	deadline := time.Now().Add(time.Second)
	for delivered.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if delivered.Load() != 1 {
		t.Error("peer invitation not presented after reconnect")
	}
	if r.boundNativeID != "same-native" || c.id != "original-session" {
		t.Error("binding replaced")
	}
	if r.health()["state"] != "ready" {
		t.Error("recovered receiver not ready")
	}
	cancel()
	<-done
	// No second native invocation or new receipt is necessary for recovery.
	if r.tracker.get("invitation") == nil {
		t.Error("delivery correlation lost")
	}
}

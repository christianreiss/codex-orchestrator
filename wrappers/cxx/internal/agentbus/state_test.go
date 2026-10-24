package agentbus

import (
	"context"
	"encoding/json"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"io"
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

func TestRelayStateClaimsOnlyOnWorkRevision(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "state.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	frames := make(chan communicator.StateFrame, 8)
	initial := make(chan communicator.StateFrame, 1)
	closed := make(chan struct{})
	server := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var open communicator.StateFrame
		if websocket.JSON.Receive(ws, &open) != nil {
			return
		}
		frame := communicator.StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: uuid.NewString(), Revision: "1", Payload: json.RawMessage(`{"ownership_mode":"connection","work_revision":"1"}`)}
		if websocket.JSON.Send(ws, frame) != nil {
			return
		}
		initial <- frame
		for {
			select {
			case <-closed:
				return
			case f := <-frames:
				if websocket.JSON.Send(ws, f) != nil {
					return
				}
			}
		}
	})}
	go server.Serve(listener)
	defer server.Close()
	defer close(closed)
	var claims atomic.Int32
	requested := make(chan struct{}, 8)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Wait int `json:"wait_seconds"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Wait != 0 {
			t.Error("claim was not finite")
		}
		claims.Add(1)
		requested <- struct{}{}
		io.WriteString(w, `{"delivery":null}`)
	}))
	defer api.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	state, err := communicator.DialStateSocket(ctx, socket, "/state", communicator.StateScope{Topic: "relay"}, communicator.StateAuth{})
	if err != nil {
		t.Fatal(err)
	}
	frame := <-initial
	client := &relayClient{baseURL: api.URL, id: uuid.NewString(), http: api.Client()}
	client.connectionOwned.Store(true)
	done := make(chan error, 1)
	go func() { done <- client.pollState(ctx, nil, io.Discard, 2, state) }()
	select {
	case <-requested:
	case <-time.After(time.Second):
		t.Fatal("initial claim missing")
	}
	select {
	case <-requested:
		t.Fatal("empty claim polled again")
	case <-time.After(80 * time.Millisecond):
	}
	// A metadata-only delta does not cause another claim.
	frame.Type = "state_delta"
	frame.Revision = "2"
	frames <- frame
	select {
	case <-requested:
		t.Fatal("metadata delta caused claim")
	case <-time.After(40 * time.Millisecond):
	}
	frame.Revision = "3"
	frame.Payload = json.RawMessage(`{"ownership_mode":"connection","work_revision":"2"}`)
	frames <- frame
	select {
	case <-requested:
	case <-time.After(time.Second):
		t.Fatal("work revision did not claim")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("relay did not close")
	}
	if claims.Load() != 2 {
		t.Fatalf("claims=%d", claims.Load())
	}
}

func TestRelayStateDisconnectDoesNotCancelAcceptedProcess(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	socket := filepath.Join(t.TempDir(), "state.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	disconnect := make(chan struct{})
	server := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var open communicator.StateFrame
		if websocket.JSON.Receive(ws, &open) != nil {
			return
		}
		websocket.JSON.Send(ws, communicator.StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: uuid.NewString(), Revision: "1", Payload: json.RawMessage(`{"ownership_mode":"connection","work_revision":"1"}`)})
		<-disconnect
	})}
	go server.Serve(listener)
	defer server.Close()
	var claims atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/deliveries/claim") && claims.Add(1) == 1 {
			io.WriteString(w, `{"delivery":{"message_id":"11111111-1111-4111-8111-111111111111","claim_id":"22222222-2222-4222-8222-222222222222","kind":"message","target":{"engine":"codex","address":"agent:33333333-3333-4333-8333-333333333333"}}}`)
			return
		}
		io.WriteString(w, `{"delivery":null}`)
	}))
	defer api.Close()
	nativeCtx := make(chan context.Context, 1)
	release := make(chan struct{})
	original := runNativeAdapter
	defer func() { runNativeAdapter = original }()
	runNativeAdapter = func(c *relayClient, ctx context.Context, cfg *config.Config, delivery *relayDelivery, upstream string, accepted bool) nativeResult {
		nativeCtx <- ctx
		<-release
		return nativeResult{Started: true, Reply: "done"}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	state, err := communicator.DialStateSocket(ctx, socket, "/state", communicator.StateScope{Topic: "relay"}, communicator.StateAuth{})
	if err != nil {
		t.Fatal(err)
	}
	client := &relayClient{baseURL: api.URL, id: uuid.NewString(), http: api.Client()}
	client.connectionOwned.Store(true)
	done := make(chan error, 1)
	go func() { done <- client.pollState(ctx, map[string]*config.Config{"codex": {}}, io.Discard, 1, state) }()
	var running context.Context
	select {
	case running = <-nativeCtx:
	case <-time.After(time.Second):
		t.Fatal("process never started")
	}
	close(disconnect)
	select {
	case <-running.Done():
		t.Fatal("stream loss canceled the accepted process")
	case <-time.After(100 * time.Millisecond):
	}
	cancel()
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("relay did not finish after parent cancellation")
	}
}

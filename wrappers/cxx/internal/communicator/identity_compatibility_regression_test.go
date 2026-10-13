package communicator

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

// The API at 5753d793 already announces ready.control:["terminate"], but its
// capabilities schema is strict and admits only type/terminate/pid/started_at.
// Announcing terminate alone cannot negotiate newer identity fields with it.
func TestIndependentIdentityIsNotSentToOldTerminateOnlyAPI(t *testing.T) {
	checked := make(chan error, 1)
	remote := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var hello map[string]any
		if err := websocket.JSON.Receive(ws, &hello); err != nil {
			checked <- err
			return
		}
		if err := websocket.JSON.Send(ws, map[string]any{"type": "ready", "protocol": 1, "control": []string{"terminate"}}); err != nil {
			checked <- err
			return
		}
		var raw json.RawMessage
		if err := websocket.JSON.Receive(ws, &raw); err != nil {
			checked <- err
			return
		}
		t.Logf("capabilities sent to old API: %s", raw)
		var oldCapabilities struct {
			Type      string `json:"type"`
			Terminate bool   `json:"terminate"`
			PID       int    `json:"pid"`
			StartedAt string `json:"started_at"`
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		checked <- decoder.Decode(&oldCapabilities)
		// The old API closes a frame its strict schema rejects.
	}))
	t.Cleanup(remote.Close)
	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: remote.URL, APIKey: "fixture"}}
	transport, err := directTransport(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer transport.CloseIdleConnections()
	ws, err := dial(context.Background(), cfg, transport)
	if err != nil {
		t.Fatal(err)
	}
	c := &connection{ws: ws, ready: make(chan struct{}), done: make(chan struct{}), pending: map[string]chan frame{}, onTerminate: func(string, <-chan struct{}) {}, runtimeID: "aaaaaaaaaaaaaaaa"}
	go c.receive()
	t.Cleanup(func() { ws.Close(); <-c.done })
	if err := c.send(map[string]any{"type": "hello", "protocol": 1, "username": "fixture", "version": "0.9.77"}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-checked:
		if err != nil {
			t.Fatalf("new owner sent identity fields without old API negotiation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("owner handshake did not complete within fixture bound")
	}
}

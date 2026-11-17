package agentbus

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

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

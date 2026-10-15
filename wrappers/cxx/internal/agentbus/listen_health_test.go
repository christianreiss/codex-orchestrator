package agentbus

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestDisconnectedCodexReceiverDoesNotUseClaudeTransport(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "codex")
	var output strings.Builder
	r := &autoReceiver{output: &mcpWriter{w: &output}}
	if err := r.deliver("notice:msg:0", "notice"); err == nil {
		t.Fatal("disconnected Codex queue accepted a notice")
	}
	if output.Len() != 0 {
		t.Fatalf("Codex notice leaked to Claude transport: %s", output.String())
	}
}

func TestListenReportsUnavailableReceiver(t *testing.T) {
	previous := receiverReadyWait
	receiverReadyWait = 10 * time.Millisecond
	t.Cleanup(func() { receiverReadyWait = previous })
	var calls []string
	c := heldDeliveryServer(t, &calls)
	tracker := newChannelTracker(c)
	tracker.receiver = &autoReceiver{client: c, tracker: tracker, sources: []string{"peer"}}
	out, err := agentListen(context.Background(), c, tracker, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if out["status"] != "receiver_unavailable" {
		t.Fatalf("a receiver that never registered reported %v", out["status"])
	}
	if !strings.Contains(out["message"].(string), "Do NOT yield") {
		t.Fatalf("message = %v", out["message"])
	}

	// A registered receiver whose heartbeat has lapsed is just as unreachable.
	tracker.receiver.setConnected(true)
	tracker.receiver.mu.Lock()
	tracker.receiver.lastBeatOK = time.Now().Add(-2 * receiverStaleAfter)
	tracker.receiver.mu.Unlock()
	if out, _ = agentListen(context.Background(), c, tracker, map[string]any{}); out["status"] != "receiver_unavailable" {
		t.Fatalf("a stale receiver reported %v", out["status"])
	}
}

func TestListenReportsHealthyReceiverAndClaimGate(t *testing.T) {
	var calls []string
	c := heldDeliveryServer(t, &calls)
	tracker := newChannelTracker(c)
	tracker.receiver = &autoReceiver{client: c, tracker: tracker, sources: []string{"peer"}}
	tracker.receiver.setConnected(true)
	tracker.receiver.setGate("thread_active")
	out, err := agentListen(context.Background(), c, tracker, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	health, _ := out["receiver"].(map[string]any)
	// Busy is the normal state of a working agent, not a fault.
	if out["status"] != "automatic" || health["state"] != "ready" || health["claim_gate"] != "thread_active" {
		t.Fatalf("out = %+v", out)
	}
}

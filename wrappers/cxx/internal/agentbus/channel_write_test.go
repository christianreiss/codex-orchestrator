package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestGuardedWriterBoundsRealBlockedPipeAndCannotWriteLate(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	w := &mcpWriter{w: left}
	if !w.supportsGuardedWrite() {
		t.Fatal("deadline-capable writer not supported")
	}
	start := time.Now()
	attempted, err := w.sendGuarded(context.Background(), start.Add(40*time.Millisecond), map[string]any{"content": "must not arrive late"})
	if !attempted || err == nil || time.Since(start) > time.Second {
		t.Fatalf("unbounded/incorrect write: attempted=%v err=%v elapsed=%v", attempted, err, time.Since(start))
	}
	_ = right.SetReadDeadline(time.Now().Add(30 * time.Millisecond))
	var data [1]byte
	if n, _ := right.Read(data[:]); n != 0 {
		t.Fatal("write survived its deadline and arrived late")
	}
}

func TestGuardedWriterRequiresDeadlineAndFailsClosedBeforeWrite(t *testing.T) {
	var buffer bytes.Buffer
	unsupported := &mcpWriter{w: &buffer}
	if unsupported.supportsGuardedWrite() {
		t.Fatal("unbounded writer advertised timing capability")
	}
	if attempted, err := unsupported.sendGuarded(context.Background(), time.Now().Add(time.Second), map[string]any{}); attempted || err == nil || buffer.Len() != 0 {
		t.Fatal("unsupported writer wrote")
	}
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	w := &mcpWriter{w: left}
	w.mu.Lock()
	start := time.Now()
	if w.supportsGuardedWrite() {
		t.Fatal("probe waited behind busy writer")
	}
	if attempted, err := w.sendGuarded(context.Background(), time.Now().Add(time.Second), map[string]any{}); attempted || err == nil || time.Since(start) > 100*time.Millisecond {
		t.Fatal("busy writer did not fail immediately")
	}
	w.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if attempted, err := w.sendGuarded(ctx, time.Now().Add(time.Second), map[string]any{}); attempted || err == nil {
		t.Fatal("canceled callback wrote")
	}
	if attempted, err := w.sendGuarded(context.Background(), time.Now().Add(-time.Second), map[string]any{}); attempted || err == nil {
		t.Fatal("expired callback wrote")
	}
}

func TestGuardedWriterSupportsNativeOSPipeAndClearsDeadline(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	w := &mcpWriter{w: write}
	if !w.supportsGuardedWrite() {
		t.Fatal("native stdout pipe lacks required deadline support")
	}
	attempted, err := w.sendGuarded(context.Background(), time.Now().Add(250*time.Millisecond), map[string]any{"content": "bounded"})
	if !attempted || err != nil {
		t.Fatalf("bounded write: %v", err)
	}
	var result map[string]any
	if err := json.NewDecoder(read).Decode(&result); err != nil || result["content"] != "bounded" {
		t.Fatalf("frame=%v err=%v", result, err)
	}
	// The expired per-frame deadline must not poison ordinary later MCP writes.
	time.Sleep(270 * time.Millisecond)
	if err := w.send(map[string]any{"content": "later"}); err != nil {
		t.Fatalf("deadline was not reset: %v", err)
	}
}

func TestOwnerExpiredCallbackDefersBeforeAnyNativeWrite(t *testing.T) {
	client := &sessionClient{id: "session"}
	tracker := newChannelTracker(client)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracker.track(ctx, "message", "claim", map[string]any{"kind": "message"})
	var buffer bytes.Buffer
	tracker.receiver = &autoReceiver{tracker: tracker, client: client, nativeDeliveryID: "native", output: &mcpWriter{w: &buffer}}
	owner := &receiverOwner{client: client, tracker: tracker}
	req := httptest.NewRequest(http.MethodPost, ownerDeliverPath, strings.NewReader(`{"session_id":"session","native_session_id":"native","message_id":"message","content":"information","write_deadline_ms":1}`))
	out := httptest.NewRecorder()
	owner.serveChannelDelivery(out, req)
	if out.Code != 409 || buffer.Len() != 0 || !strings.Contains(out.Body.String(), "native_boundary_changed") {
		t.Fatalf("late callback reached native: %d %s", out.Code, out.Body.String())
	}
}

func TestTurnBoundaryHookTimeoutOutlivesGuardAndKeepsTelemetryBudget(t *testing.T) {
	if activityHookTimeout("UserPromptSubmit") <= 3*time.Second || activityHookTimeout("Stop") <= 3*time.Second {
		t.Fatal("turn-boundary hook can time out behind guard")
	}
	for _, event := range []string{"PostToolUse", "PermissionRequest", "Elicitation", "StopFailure"} {
		if activityHookTimeout(event) != 500*time.Millisecond {
			t.Fatalf("changed ordinary telemetry budget: %s", event)
		}
	}
}

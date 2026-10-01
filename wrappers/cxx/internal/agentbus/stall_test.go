package agentbus

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAwaitedVerb(t *testing.T) {
	for content, want := range map[string]string{
		"CALL/1 HELLO\nhi":                      "HELLO",
		"CALL/1 HELLO-ACK deadline=x turn=1/16": "HELLO-ACK",
		"CALL/1 SAY turn=2/16\r\nbody":          "SAY",
		"CALL/1 ASK":                            "ASK",
		"CALL/1 BYE reason=done":                "BYE",
		"CALL/1 WAIT eta=60":                    "",
		"CALL/1 HOLD":                           "",
		"CALL/1 BYE-ACK":                        "",
		"CALL/1 FIN":                            "",
		"CALL/1 SAYING":                         "",
		"plain text, not a call message":        "",
		"prefix\nCALL/1 HELLO":                  "",
	} {
		got, ok := awaitedVerb(content)
		if got != want || ok != (want != "") {
			t.Errorf("awaitedVerb(%q) = %q, %v; want %q", content, got, ok, want)
		}
	}
}

type firedNote struct {
	conversation, message, verb string
	prior                       int
}

func collectStalls(t *testing.T, after time.Duration) (*stallWatcher, func(...string), func() []firedNote) {
	t.Helper()
	previous := stallAfter
	stallAfter = after
	t.Cleanup(func() { stallAfter = previous })
	var mu sync.Mutex
	var fired []firedNote
	w := newStallWatcher()
	t.Cleanup(w.stopAll)
	arm := func(args ...string) {
		w.arm(args[0], args[1], args[2], func(conversation, message, verb string, prior int) {
			mu.Lock()
			fired = append(fired, firedNote{conversation, message, verb, prior})
			mu.Unlock()
		})
	}
	snapshot := func() []firedNote {
		mu.Lock()
		defer mu.Unlock()
		return append([]firedNote(nil), fired...)
	}
	return w, arm, snapshot
}

// A silent peer is reminded about exactly twice, then left alone: the watch is a
// bounded nudge, never a polling loop.
func TestStallWatcherFiresBoundedNotes(t *testing.T) {
	_, arm, fired := collectStalls(t, 20*time.Millisecond)
	arm("conv", "msg", "HELLO")
	time.Sleep(250 * time.Millisecond)
	got := fired()
	if len(got) != stallMaxNotes || got[0].prior != 0 || got[1].prior != 1 || got[0].message != "msg" || got[0].verb != "HELLO" {
		t.Fatalf("notes = %+v", got)
	}
}

func TestStallWatcherCancelAndSupersede(t *testing.T) {
	w, arm, fired := collectStalls(t, 40*time.Millisecond)
	arm("cancelled", "m1", "SAY")
	arm("superseded", "old", "ASK")
	arm("superseded", "new", "ASK")
	// The peer answering the cancelled conversation must silence it.
	w.cancel("cancelled")
	time.Sleep(60 * time.Millisecond)
	got := fired()
	if len(got) == 0 {
		t.Fatal("superseding watch never fired")
	}
	for _, note := range got {
		if note.conversation == "cancelled" || note.message == "old" {
			t.Fatalf("stale watch fired: %+v", note)
		}
	}
}

func TestStallWatcherNilIsInert(t *testing.T) {
	var w *stallWatcher
	w.arm("c", "m", "SAY", func(string, string, string, int) { t.Error("fired") })
	w.cancel("c")
	w.stopAll()
}

// The stall note is injected through the same path as a peer message, says it
// was written locally, and carries the server's view of the message so the model
// (and the human) can tell an unclaimed message from a claimed-but-silent one.
func TestNoteStalledInjectsLocalNoticeWithServerStatus(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	for status, want := range map[string]string{
		"queued":   "never claimed",
		"accepted": "claimed it",
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if !strings.HasSuffix(req.URL.Path, "/message") {
				t.Errorf("unexpected op %s", req.URL.Path)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"message": map[string]any{"status": status}})
		}))
		c := &sessionClient{id: "session", http: &http.Client{Transport: rewriteTransport{server: server}}}
		var output strings.Builder
		r := &autoReceiver{client: c, output: &mcpWriter{w: &output}}
		r.noteStalled(context.Background(), "conv-1", "msg-1", "HELLO", 0)
		r.noteStalled(context.Background(), "conv-1", "msg-1", "HELLO", 1)
		server.Close()
		text := output.String()
		for _, part := range []string{"notifications/claude/channel", "cxx notice", "not by a peer", "CALL/1 HELLO", "stall:msg-1:0", "stall:msg-1:1", "conv-1", want} {
			if !strings.Contains(text, part) {
				t.Errorf("status %s: notice lacks %q:\n%s", status, part, text)
			}
		}
	}
}

func TestDisconnectedCodexReceiverDoesNotUseClaudeTransport(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "codex")
	var output strings.Builder
	r := &autoReceiver{output: &mcpWriter{w: &output}}
	if err := r.deliver("stall:msg:0", "notice"); err == nil {
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
	tracker.receiver = &autoReceiver{client: c, tracker: tracker}
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
	tracker.receiver = &autoReceiver{client: c, tracker: tracker}
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

// The dead-air watch is armed by the tools that send a message someone must
// answer, and disarmed by agent_cancel -- and only in automatic mode, where the
// model has yielded and cannot count empty listens itself.
func TestToolsArmAndDisarmTheStallWatch(t *testing.T) {
	previous := stallAfter
	stallAfter = time.Hour
	t.Cleanup(func() { stallAfter = previous })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"conversation_id": "conv",
			"message":         map[string]any{"id": "msg", "conversation_id": "conv"},
		})
	}))
	t.Cleanup(server.Close)
	c := &sessionClient{id: "session", http: &http.Client{Transport: rewriteTransport{server: server}}}
	tracker := newChannelTracker(c)
	r := &autoReceiver{client: c, tracker: tracker, stall: newStallWatcher()}
	t.Cleanup(r.stall.stopAll)
	tracker.receiver = r
	watching := func() int {
		r.stall.mu.Lock()
		defer r.stall.mu.Unlock()
		return len(r.stall.watches)
	}
	ctx := context.Background()

	if _, err := callMCPTool(ctx, c, tracker, "agent_call_join", map[string]any{"pin": "0126", "content": "not a call header"}); err != nil {
		t.Fatal(err)
	}
	if watching() != 0 {
		t.Fatal("a message with no CALL/1 verb was watched")
	}
	if _, err := callMCPTool(ctx, c, tracker, "agent_call_join", map[string]any{"pin": "0126", "content": "CALL/1 HELLO\nhi"}); err != nil {
		t.Fatal(err)
	}
	if watching() != 1 {
		t.Fatal("HELLO was not watched")
	}
	if _, err := callMCPTool(ctx, c, tracker, "agent_cancel", map[string]any{"conversation_id": "conv"}); err != nil {
		t.Fatal(err)
	}
	if watching() != 0 {
		t.Fatal("agent_cancel left the watch armed")
	}

	// Outside automatic mode there is no receiver to inject through: no watch, no panic.
	plain := newChannelTracker(c)
	if _, err := callMCPTool(ctx, c, plain, "agent_call_join", map[string]any{"pin": "0126", "content": "CALL/1 HELLO\nhi"}); err != nil {
		t.Fatal(err)
	}
}

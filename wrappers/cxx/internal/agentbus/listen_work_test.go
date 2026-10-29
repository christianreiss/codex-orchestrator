package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// Regression for feedback 8efceda3 (2026-10-14): a coordinator holding accepted
// work answered a turn-end ring with agent_listen while its subagents were still
// running. Listen completed the work without a body, so the server stored an
// "unknown" outcome and the claim was gone before the real result existed.
func heldWorkClient(t *testing.T, posted *[]string, bodies *[]map[string]any) *sessionClient {
	t.Helper()
	var mu sync.Mutex
	return &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		mu.Lock()
		*posted = append(*posted, strings.TrimPrefix(req.URL.Path, "/host/agent-sessions/session/agent-messaging/"))
		*bodies = append(*bodies, body)
		mu.Unlock()
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}}
}

func TestAutomaticListenNeverCompletesHeldWork(t *testing.T) {
	var posted []string
	var bodies []map[string]any
	c := heldWorkClient(t, &posted, &bodies)
	tracker := newChannelTracker(c)
	tracker.receiver = &autoReceiver{client: c, tracker: tracker, connected: true, sources: []string{"peer"}, lastBeatOK: time.Now()}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	work := tracker.track(ctx, "work-1", "claim-work", map[string]any{"work_kind": "request", "sender": map[string]any{"name": "Irmtrud"}})
	tracker.track(ctx, "info-1", "claim-info", map[string]any{"kind": "message"})

	out, err := agentListen(ctx, c, tracker, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if out["status"] != "work_held" {
		t.Fatalf("status = %v; held work must be reported, not hidden behind automatic", out["status"])
	}
	if ids, _ := out["held_work"].([]string); len(ids) != 1 || ids[0] != "work-1" {
		t.Fatalf("held_work = %v", out["held_work"])
	}
	if msg, _ := out["message"].(string); !strings.Contains(msg, "agent_task_result") {
		t.Fatalf("no result guidance: %q", msg)
	}
	if tracker.get("work-1") != work {
		t.Fatal("listen dropped accepted work it had no result for")
	}
	if tracker.get("info-1") != nil {
		t.Fatal("listen must still release the informational delivery")
	}
	for i, path := range posted {
		if path == "deliveries/work-1/ack" {
			t.Fatalf("listen acknowledged held work: %v", bodies[i])
		}
	}
}

// Feedback b0f9361b (2026-10-28): mid-turn agent_listen answered "automatic"
// with claim_gate thread_working and no body, and the model kept calling it.
// The answer must say the queued messages land only after this turn ends.
func TestAutomaticListenSaysQueuedMailWaitsForTheTurnEnd(t *testing.T) {
	var posted []string
	var bodies []map[string]any
	c := heldWorkClient(t, &posted, &bodies)
	tracker := newChannelTracker(c)
	tracker.receiver = &autoReceiver{client: c, tracker: tracker, connected: true, sources: []string{"peer"}, lastBeatOK: time.Now(), gate: "thread_working", gateSince: time.Now(), deliveryTimingV1: true}
	out, err := agentListen(context.Background(), c, tracker, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	msg, _ := out["message"].(string)
	if out["status"] != "automatic" || !strings.Contains(msg, "after the current turn ends") || !strings.Contains(msg, "never returns a message body") || !strings.Contains(msg, "does not fetch") {
		t.Fatalf("automatic listen does not explain turn-gated delivery: %v", out)
	}
	// An ungated receiver keeps the plain yield guidance.
	tracker.receiver.deliveryTimingV1 = false
	tracker.receiver.gate = "open"
	out, err = agentListen(context.Background(), c, tracker, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if msg, _ := out["message"].(string); strings.Contains(msg, "after the current turn ends") || !strings.Contains(msg, "Yield this model turn") {
		t.Fatalf("ungated listen message = %q", msg)
	}
}

func TestManualListenDoesNotClaimOrCompleteBehindHeldWork(t *testing.T) {
	var posted []string
	var bodies []map[string]any
	c := heldWorkClient(t, &posted, &bodies)
	tracker := newChannelTracker(c)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracker.track(ctx, "work-1", "claim-work", map[string]any{"kind": "task"})

	out, err := agentListen(ctx, c, tracker, map[string]any{"wait_seconds": 0})
	if err != nil {
		t.Fatal(err)
	}
	if out["status"] != "work_held" || tracker.get("work-1") == nil {
		t.Fatalf("manual listen released held work: %v", out)
	}
	for _, path := range posted {
		if path == "deliveries/claim" || strings.HasSuffix(path, "/ack") {
			t.Fatalf("manual listen posted %v while work was held", posted)
		}
	}
}

// A result whose storage receipt was lost is the one piece of work listen may
// finish: it replays the exact explicit body, never an unknown outcome.
func TestListenRetriesAnExplicitWorkResult(t *testing.T) {
	var posted []string
	var bodies []map[string]any
	c := heldWorkClient(t, &posted, &bodies)
	tracker := newChannelTracker(c)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pending := tracker.track(ctx, "work-1", "claim-work", map[string]any{"work_kind": "request"})
	result := map[string]any{"status": "succeeded", "summary": "All hosts patched"}
	if err := pending.setCompletion(map[string]any{"claim_id": "claim-work", "outcome": "completed", "task_result": result}); err != nil {
		t.Fatal(err)
	}
	if err := tracker.completeOutstanding(ctx); err != nil {
		t.Fatal(err)
	}
	if tracker.get("work-1") != nil {
		t.Fatal("stored result was not confirmed")
	}
	if len(bodies) != 1 || bodies[0]["task_result"] == nil {
		t.Fatalf("listen replayed %v; want the explicit result", bodies)
	}
}

// The turn-end ring sent the coordinator to agent_listen. While work is held it
// must say the new message waits behind it instead.
func TestRingBehindHeldWorkDoesNotSendTheModelToListen(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "66666666-6666-4666-8666-666666666666")
	box := &mailbox{Pending: []mailboxEntry{{MessageID: "next", From: mailboxPeer{Alias: "Irmtrud"}}}}
	var out bytes.Buffer
	if err := emitHook(&out, hookEventStop, box, &turnEnd{receiverReady: true, blocked: true}); err != nil {
		t.Fatal(err)
	}
	var hook map[string]any
	if err := json.Unmarshal(out.Bytes(), &hook); err != nil {
		t.Fatal(err)
	}
	reason, _ := hook["reason"].(string)
	if !strings.Contains(reason, "queued behind accepted work") || !strings.Contains(reason, "does not release") || strings.Contains(reason, "To answer, call `agent_listen`") {
		t.Fatalf("ring behind held work still points at agent_listen: %q", reason)
	}
	out.Reset()
	t.Setenv(envSessionID, "77777777-7777-4777-8777-777777777777")
	if err := emitHook(&out, hookEventStop, box, &turnEnd{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "To answer, call `agent_listen`") {
		t.Fatalf("an unblocked ring lost its listen guidance: %s", out.String())
	}
}

// A legacy schedule (no work_kind) is still tracked as work, so its prompt must
// name the result tool: agent_listen would only answer work_held.
func TestLegacySchedulePromptNamesTheResultTool(t *testing.T) {
	prompt := nativePeerPrompt(map[string]any{"message_id": "wake-1", "kind": "schedule", "content": "check backups"})
	if !strings.Contains(prompt, "agent_task_result") || strings.Contains(prompt, "call agent_listen once to release") {
		t.Fatalf("schedule prompt still finishes with agent_listen: %q", prompt)
	}
}

// Regression for feedback bad0e24b / 19c4817d (2026-10-16): a progress-only
// agent_reply on accepted work acknowledged the delivery as completed, so the
// server stored "unknown" and the later agent_task_result found no held delivery.
func TestProgressReplyKeepsAcceptedWorkHeld(t *testing.T) {
	var posted []string
	var bodies []map[string]any
	c := heldWorkClient(t, &posted, &bodies)
	tracker := newChannelTracker(c)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	work := tracker.track(ctx, "work-1", "claim-work", map[string]any{"work_kind": "request"})

	for _, text := range []string{"accepted, deploying", "half done"} {
		out, err := callMCPTool(ctx, c, tracker, "agent_reply", map[string]any{"message_id": "work-1", "content": text, "delivery_class": "progress"})
		if err != nil {
			t.Fatal(err)
		}
		if out["work_status"] != "held" {
			t.Fatalf("receipt must say work stays held: %v", out)
		}
	}
	if tracker.get("work-1") != work || work.reply() != nil || len(tracker.heldWork()) != 1 {
		t.Fatal("progress reply released accepted work")
	}
	if len(posted) != 2 || posted[0] != "reply" || posted[1] != "reply" {
		t.Fatalf("progress replies posted %v; nothing may be acknowledged", posted)
	}
	if bodies[0]["claim_id"] != "claim-work" || bodies[0]["delivery_class"] != "progress" ||
		bodies[0]["client_message_id"] == bodies[1]["client_message_id"] || bodies[0]["client_message_id"] == work.replyClientID {
		t.Fatalf("progress bodies = %v", bodies)
	}

	if _, err := callMCPTool(ctx, c, tracker, "agent_task_result", map[string]any{"message_id": "work-1", "task_result": map[string]any{"status": "succeeded", "summary": "deployed"}}); err != nil {
		t.Fatalf("final result after progress: %v", err)
	}
	if posted[len(posted)-1] != "deliveries/work-1/ack" || tracker.get("work-1") != nil {
		t.Fatalf("final result did not finish the work: %v", posted)
	}
}

// A reply that is not progress stays the terminal answer to the work.
func TestPlainReplyWithoutResultStillFinishesWork(t *testing.T) {
	var posted []string
	var bodies []map[string]any
	c := heldWorkClient(t, &posted, &bodies)
	tracker := newChannelTracker(c)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracker.track(ctx, "work-1", "claim-work", map[string]any{"work_kind": "request"})
	if _, err := callMCPTool(ctx, c, tracker, "agent_reply", map[string]any{"message_id": "work-1", "content": "answer"}); err != nil {
		t.Fatal(err)
	}
	if tracker.get("work-1") != nil || posted[len(posted)-1] != "deliveries/work-1/ack" {
		t.Fatalf("a non-progress reply remains the terminal answer: %v", posted)
	}
}

// Feedback 706ceff7 (2026-10-29): agent_reply with task_result finished the
// work, then agent_task_result on the same message failed with "this process
// does not hold that delivery". The reply receipt carries the server's echo,
// and a follow-up result is an idempotent retry or a named conflict.
func TestTaskResultAfterFinishingReplyNamesTheStoredOutcome(t *testing.T) {
	var posted []string
	echo := map[string]any{"message_id": "work-1", "claim_id": "claim-work", "status": "succeeded", "summary": "deployed", "stored_at": "2026-10-29T06:50:00.000Z"}
	c := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		path := strings.TrimPrefix(req.URL.Path, "/host/agent-sessions/session/agent-messaging/")
		posted = append(posted, path)
		body := `{}`
		if path == "reply" {
			raw, _ := json.Marshal(map[string]any{"message": map[string]any{"id": "reply-1", "task_result_status": nil}, "task_result": echo})
			body = string(raw)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	tracker := newChannelTracker(c)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracker.track(ctx, "work-1", "claim-work", map[string]any{"work_kind": "request"})
	result := map[string]any{"status": "succeeded", "summary": "deployed"}
	out, err := callMCPTool(ctx, c, tracker, "agent_reply", map[string]any{"message_id": "work-1", "content": "done", "task_result": result})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := out["task_result"].(map[string]any); got["status"] != "succeeded" {
		t.Fatalf("reply receipt must show the recorded outcome: %v", out)
	}
	calls := len(posted)

	again, err := callMCPTool(ctx, c, tracker, "agent_task_result", map[string]any{"message_id": "work-1", "task_result": map[string]any{"status": "succeeded", "summary": " deployed "}})
	if err != nil {
		t.Fatalf("same result after a finishing reply must be idempotent: %v", err)
	}
	if again["already_recorded"] != true || again["recorded_by"] != "agent_reply" {
		t.Fatalf("receipt = %v", again)
	}
	if got, _ := again["task_result"].(map[string]any); got["stored_at"] != echo["stored_at"] {
		t.Fatalf("receipt must carry the server's recorded outcome: %v", again)
	}
	_, err = callMCPTool(ctx, c, tracker, "agent_task_result", map[string]any{"message_id": "work-1", "task_result": map[string]any{"status": "failed", "summary": "rolled back"}})
	if err == nil || !strings.Contains(err.Error(), "agent_task_result_conflict") || !strings.Contains(err.Error(), `"succeeded"`) {
		t.Fatalf("a different result must name the stored outcome: %v", err)
	}
	if len(posted) != calls {
		t.Fatalf("finished work must not be acknowledged again: %v", posted[calls:])
	}
}

// A plain reply stores unknown; a later explicit result must say so, not
// pretend the delivery was never held.
func TestTaskResultAfterPlainReplyNamesUnknown(t *testing.T) {
	var posted []string
	var bodies []map[string]any
	c := heldWorkClient(t, &posted, &bodies)
	tracker := newChannelTracker(c)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracker.track(ctx, "work-1", "claim-work", map[string]any{"work_kind": "request"})
	if _, err := callMCPTool(ctx, c, tracker, "agent_reply", map[string]any{"message_id": "work-1", "content": "answer"}); err != nil {
		t.Fatal(err)
	}
	_, err := callMCPTool(ctx, c, tracker, "agent_task_result", map[string]any{"message_id": "work-1", "task_result": map[string]any{"status": "succeeded", "summary": "done"}})
	if err == nil || !strings.Contains(err.Error(), `"unknown"`) {
		t.Fatalf("expected the stored unknown outcome to be named: %v", err)
	}
	if _, err := callMCPTool(ctx, c, tracker, "agent_task_result", map[string]any{"message_id": "never-held", "task_result": map[string]any{"status": "succeeded", "summary": "done"}}); err == nil || !strings.Contains(err.Error(), "does not hold") {
		t.Fatalf("unknown deliveries still fail plainly: %v", err)
	}
}

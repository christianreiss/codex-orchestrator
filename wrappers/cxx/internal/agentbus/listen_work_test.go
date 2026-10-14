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

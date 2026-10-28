package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// transcriptLines renders Claude Code transcript entries the way the live
// biest transcripts record a channel delivery: a queue-operation when the
// notification is queued, and a user entry once it is dequeued into the turn.
func channelText(id string) string {
	return `<channel source="plugin:cxx-receiver:cxx-agent" message_id="` + id + `">` + "\nbody\n</channel>"
}

func writeTranscript(t *testing.T, entries ...map[string]any) string {
	t.Helper()
	var buf bytes.Buffer
	for _, entry := range entries {
		raw, err := json.Marshal(entry)
		if err != nil {
			t.Fatal(err)
		}
		buf.Write(raw)
		buf.WriteByte('\n')
	}
	file := filepath.Join(t.TempDir(), "transcript.jsonl")
	if err := os.WriteFile(file, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func queued(id string) map[string]any {
	return map[string]any{"type": "queue-operation", "operation": "enqueue", "content": channelText(id)}
}

func dequeued(id string) map[string]any {
	return map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": channelText(id)}}
}

func TestSeenInTranscriptCountsOnlyDequeuedChannelEntries(t *testing.T) {
	file := writeTranscript(t,
		dequeued("read-string"),
		map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []map[string]any{{"type": "text", "text": channelText("read-blocks")}}}},
		// Queued in the turn's last moments: Claude Code will start the next turn
		// with it, so it has not been read yet.
		queued("still-queued"),
		// A tool result quoting the tag is not a delivery.
		map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []map[string]any{{"type": "tool_result", "content": channelText("quoted")}}}},
	)
	held := []heldDelivery{{MessageID: "read-string"}, {MessageID: "read-blocks"}, {MessageID: "still-queued"}, {MessageID: "quoted"}, {MessageID: "never-delivered"}}
	seen := seenInTranscript(file, held)
	if !seen["read-string"] || !seen["read-blocks"] {
		t.Fatalf("dequeued deliveries not recognised: %v", seen)
	}
	if seen["still-queued"] || seen["quoted"] || seen["never-delivered"] {
		t.Fatalf("an unread delivery counted as read: %v", seen)
	}
	if got := seenInTranscript(filepath.Join(t.TempDir(), "missing.jsonl"), held); len(got) != 0 {
		t.Fatalf("missing transcript must read as nothing seen, got %v", got)
	}
}

// The live wedge: a read reply stays held after the turn ends, so the receiver
// never claims again. The hook must release exactly the read informational
// delivery through the launch's receiver owner, and leave work alone.
func TestTurnEndReleasesReadInformationalDeliveryButKeepsWork(t *testing.T) {
	var runs atomic.Int32
	dir := t.TempDir()
	owner := ownerFixture(t, filepath.Join(dir, ownerSocketName), &runs)
	var acks []string
	owner.client.http.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		acks = append(acks, path.Base(path.Dir(req.URL.Path)))
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})
	for id, work := range map[string]string{"read-reply": "", "unread-reply": "", "read-work": "request"} {
		owner.tracker.items[id] = &channelPending{claimID: "claim-" + id, workKind: work, sender: "Thekla", cancel: func() {}}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); owner.run(ctx, io.Discard) }()
	defer func() { cancel(); <-done }()
	waitOwner(t, owner)
	t.Setenv(envSocket, filepath.Join(dir, "portal.sock"))
	t.Setenv(envSessionID, owner.client.id)

	end := releaseAtTurnEnd(writeTranscript(t, dequeued("read-reply"), queued("unread-reply"), dequeued("read-work")), 3*time.Second)
	if end == nil {
		t.Fatal("hook could not reach the receiver owner")
	}
	if end.released != 1 || strings.Join(acks, ",") != "read-reply" {
		t.Fatalf("released %d via %v; want only read-reply", end.released, acks)
	}
	owner.tracker.mu.Lock()
	_, workHeld := owner.tracker.items["read-work"]
	_, unreadHeld := owner.tracker.items["unread-reply"]
	_, readHeld := owner.tracker.items["read-reply"]
	owner.tracker.mu.Unlock()
	if readHeld || !workHeld || !unreadHeld {
		t.Fatalf("wrong deliveries released: read=%v work=%v unread=%v", readHeld, workHeld, unreadHeld)
	}
	if len(end.stillHeld) != 1 || end.stillHeld[0].MessageID != "read-work" || end.stillHeld[0].Kind != "work" || end.stillHeld[0].Sender != "Thekla" {
		t.Fatalf("still held = %+v; want only the read work", end.stillHeld)
	}
}

func TestTurnEndWithoutOwnerChangesNothing(t *testing.T) {
	t.Setenv(envSocket, filepath.Join(t.TempDir(), "portal.sock"))
	t.Setenv(envSessionID, "launch")
	if end := releaseAtTurnEnd(writeTranscript(t, dequeued("m")), 500*time.Millisecond); end != nil {
		t.Fatalf("an older or absent owner must leave the hook unchanged, got %+v", end)
	}
	t.Setenv(envSocket, "")
	if end := releaseAtTurnEnd("", time.Second); end != nil {
		t.Fatal("no launch environment must mean no release")
	}
}

func TestStopAfterReleaseDoesNotRingWhatTheReceiverWillDeliver(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "44444444-4444-4444-8444-444444444444")
	box := &mailbox{Pending: []mailboxEntry{{MessageID: "next", From: mailboxPeer{Alias: "Thekla"}}}}
	var out bytes.Buffer
	if err := emitHook(&out, hookEventStop, box, &turnEnd{released: 1, receiverReady: true}); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatalf("a reopened receiver delivers on its own; the Stop hook must not block: %s", out.String())
	}
	// A dead receiver cannot deliver, so the ring stays the fallback.
	if err := emitHook(&out, hookEventStop, box, &turnEnd{released: 1}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"decision":"block"`) {
		t.Fatalf("an unavailable receiver must still ring: %s", out.String())
	}
}

// Feedback b0f9361b (2026-10-28): a busy coordinator was rung at Stop with "call
// agent_listen", which returned status automatic and no body, while the block
// itself kept the turn running and so kept the after-turn claim gate shut.
// With turn-gated delivery the receiver pushes pending mail once the turn ends;
// the Stop hook must let it end instead of blocking.
func TestStopDoesNotBlockMailTheReceiverPushesAfterTheTurn(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "88888888-8888-4888-8888-888888888888")
	box := &mailbox{Pending: []mailboxEntry{{MessageID: "next", From: mailboxPeer{Alias: "Thekla"}}}}
	var quiet bytes.Buffer
	if err := emitHook(&quiet, hookEventStop, box, &turnEnd{receiverReady: true, afterTurn: true}); err != nil {
		t.Fatal(err)
	}
	if quiet.Len() != 0 {
		t.Fatalf("the receiver delivers after Stop; blocking only delays it: %s", quiet.String())
	}
	// Nothing was rung, so the next prompt still announces it.
	if fresh, _ := unrung(hookEventPrompt, box); len(fresh) != 1 {
		t.Fatalf("a suppressed Stop must not consume the prompt ring, fresh=%d", len(fresh))
	}
	// Without turn-gated delivery (an older owner or server) the ring stays.
	var out bytes.Buffer
	if err := emitHook(&out, hookEventStop, box, &turnEnd{receiverReady: true}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"decision":"block"`) {
		t.Fatalf("an older owner must keep the Stop ring: %s", out.String())
	}
}

func TestPromptRingSaysMailArrivesAfterTheTurn(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "99999999-9999-4999-8999-999999999999")
	box := &mailbox{Pending: []mailboxEntry{{MessageID: "m-1", From: mailboxPeer{Alias: "Thekla"}}, {MessageID: "m-2", From: mailboxPeer{Alias: "Irmtrud"}}}}
	var out bytes.Buffer
	if err := emitHook(&out, hookEventPrompt, box, &turnEnd{receiverReady: true, afterTurn: true}); err != nil {
		t.Fatal(err)
	}
	var hook map[string]any
	if err := json.Unmarshal(out.Bytes(), &hook); err != nil {
		t.Fatalf("hook output is not JSON: %v (%q)", err, out.String())
	}
	specific, _ := hook["hookSpecificOutput"].(map[string]any)
	context, _ := specific["additionalContext"].(string)
	for _, want := range []string{"Thekla", "Irmtrud", "after the current turn ends", "delivery_timing", "does not help"} {
		if !strings.Contains(context, want) {
			t.Fatalf("after-turn ring lacks %q: %q", want, context)
		}
	}
	if strings.Contains(context, "To answer, call `agent_listen`") {
		t.Fatalf("after-turn ring still sends the model to agent_listen for a body: %q", context)
	}
	if human, _ := hook["systemMessage"].(string); !strings.Contains(human, "after this turn") {
		t.Fatalf("the operator should learn when the call lands: %q", human)
	}
}

// A delivery the model read stays held when its release failed; then only
// agent_listen reopens reception, so that ring keeps pointing at it.
func TestStopStillRingsWhileAReadDeliveryIsHeld(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	box := &mailbox{Pending: []mailboxEntry{{MessageID: "next", From: mailboxPeer{Alias: "Thekla"}}}}
	var out bytes.Buffer
	end := &turnEnd{receiverReady: true, afterTurn: true, stillHeld: []heldDelivery{{MessageID: "read-1", Kind: "informational"}}}
	if err := emitHook(&out, hookEventStop, box, end); err != nil {
		t.Fatal(err)
	}
	var hook map[string]any
	if err := json.Unmarshal(out.Bytes(), &hook); err != nil {
		t.Fatalf("hook output is not JSON: %v (%q)", err, out.String())
	}
	reason, _ := hook["reason"].(string)
	if hook["decision"] != "block" || !strings.Contains(reason, "agent_listen") || !strings.Contains(reason, "once") {
		t.Fatalf("held delivery ring must name a single agent_listen: %v", hook)
	}
}

// The header promise: a ringer that cannot record what it rang must not block,
// or every Stop rings and blocks again.
func TestStopDoesNotBlockWhenTheLedgerCannotBeWritten(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home-is-a-file")
	if err := os.WriteFile(home, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv(envSessionID, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	box := &mailbox{Pending: []mailboxEntry{{MessageID: "m-1", From: mailboxPeer{Alias: "Thekla"}}}}
	var out bytes.Buffer
	if err := emitHook(&out, hookEventStop, box, nil); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatalf("an unrecorded Stop ring would block every turn end: %s", out.String())
	}
}

func TestHeldReportCarriesTurnGating(t *testing.T) {
	client := &sessionClient{id: "launch"}
	tracker := newChannelTracker(client)
	tracker.receiver = &autoReceiver{client: client, tracker: tracker, connected: true, sources: []string{"peer"}, lastBeatOK: time.Now(), gate: "thread_working", gateSince: time.Now(), deliveryTimingV1: true}
	report := tracker.heldReport()
	if !report.ReceiverReady || !report.DeliveryAfterTurn {
		t.Fatalf("held report = %+v", report)
	}
	tracker.receiver.deliveryTimingV1 = false
	if tracker.heldReport().DeliveryAfterTurn {
		t.Fatal("a receiver without turn-gated delivery must not claim it")
	}
}

func TestStopRingsOnceAboutReadWorkThatBlocksReception(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "55555555-5555-4555-8555-555555555555")
	end := &turnEnd{receiverReady: true, stillHeld: []heldDelivery{
		{MessageID: "work-1", Kind: "work", Sender: "Thekla"},
		{MessageID: "portal-1", Kind: "portal"},
	}}
	var out bytes.Buffer
	if err := emitHook(&out, hookEventStop, &mailbox{}, end); err != nil {
		t.Fatal(err)
	}
	var hook map[string]any
	if err := json.Unmarshal(out.Bytes(), &hook); err != nil {
		t.Fatal(err)
	}
	reason, _ := hook["reason"].(string)
	if hook["decision"] != "block" || !strings.Contains(reason, "work-1 from Thekla") || !strings.Contains(reason, "agent_task_result") || !strings.Contains(reason, "agent_receiver_reply") {
		t.Fatalf("held work ring missing guidance: %v", hook)
	}
	out.Reset()
	// The Stop hook has no stop_hook_active guard; a second block would wedge
	// the turn while the model legitimately waits on the work.
	if err := emitHook(&out, hookEventStop, &mailbox{}, end); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatalf("held work rang twice: %s", out.String())
	}
}

// End to end on the receiver loop: the first message is read and the turn ends
// without agent_listen. Before this fix the loop stayed on held_delivery for
// good; a turn-end release must let it claim and push the next one unprompted.
func TestReceiverDeliversNextMessageAfterTurnEndRelease(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var claims, delivered atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		out := map[string]any{}
		switch path.Base(req.URL.Path) {
		case "ack":
			out["message"] = map[string]any{"status": "accepted"}
		case "native":
			out["native_session_id"] = "native"
		case "register":
			out["sources"] = []string{"peer"}
		case "claim":
			if n := claims.Add(1); n <= 2 {
				out["delivery"] = map[string]any{"message_id": fmt.Sprintf("m%d", n), "kind": "reply", "content": "noted"}
			}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer server.Close()
	c := &sessionClient{id: "session", http: &http.Client{Transport: rewriteTransport{server: server}}}
	tracker := newChannelTracker(c)
	r := &autoReceiver{client: c, tracker: tracker}
	tracker.receiver = r
	r.output = &mcpWriter{w: receiverHealthWriter{r: r, deliveries: &delivered}}
	done := make(chan error, 1)
	go func() { done <- r.connection(ctx) }()
	waitFor := func(what string, cond func() bool) {
		t.Helper()
		for !cond() {
			if ctx.Err() != nil {
				t.Fatalf("timed out waiting for %s (claims %d, delivered %d)", what, claims.Load(), delivered.Load())
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	waitFor("first delivery", func() bool { return delivered.Load() == 1 })
	time.Sleep(2500 * time.Millisecond)
	if claims.Load() != 1 {
		t.Fatalf("receiver claimed past a held delivery (claims %d)", claims.Load())
	}
	if report, err := tracker.releaseSeen(ctx, []string{"m1"}); err != nil || len(report.Released) != 1 {
		t.Fatalf("turn-end release failed: %+v %v", report, err)
	}
	waitFor("second delivery without a prompt", func() bool { return delivered.Load() == 2 })
	cancel()
	<-done
}

// Codex and Grok have no hooks, so the receiver watches the native thread
// instead: a busy spell after the submission, then a settled idle, means the
// model consumed the message and ended its turn. Seen live on 2026-10-12: a
// Codex and a Grok target that answered with agent_send and skipped
// agent_listen left the next message queued for good.
func TestNativeTurnEndReleasesConsumedInformationalDelivery(t *testing.T) {
	var calls []string
	client := heldDeliveryServer(t, &calls)
	tracker := newChannelTracker(client)
	r := &autoReceiver{client: client, tracker: tracker, connected: true, sources: []string{"peer"}, lastBeatOK: time.Now()}
	tracker.receiver = r
	delivered := time.Now()
	tracker.items["held"] = &channelPending{claimID: "claim", cancel: func() {}, nativeAt: delivered}
	tracker.items["work"] = &channelPending{claimID: "claim-work", workKind: "request", cancel: func() {}, nativeAt: delivered}
	ctx := context.Background()
	at := func(d time.Duration) time.Time { return delivered.Add(d) }

	// Still idle right after submission: the TUI has not picked it up yet.
	r.releaseAfterNativeTurn(ctx, "idle", at(time.Second))
	r.releaseAfterNativeTurn(ctx, "idle", at(30*time.Second))
	if len(calls) != 0 {
		t.Fatalf("released before the thread ever ran the delivery: %v", calls)
	}
	r.releaseAfterNativeTurn(ctx, "active", at(31*time.Second))
	r.releaseAfterNativeTurn(ctx, "idle", at(40*time.Second))
	r.releaseAfterNativeTurn(ctx, "idle", at(45*time.Second))
	if len(calls) != 0 {
		t.Fatalf("released before the idle thread settled: %v", calls)
	}
	// A queued follow-up turned the thread busy again: start over.
	r.releaseAfterNativeTurn(ctx, "working", at(46*time.Second))
	r.releaseAfterNativeTurn(ctx, "idle", at(50*time.Second))
	r.releaseAfterNativeTurn(ctx, "idle", at(61*time.Second))
	if strings.Join(calls, ",") != "deliveries/held/ack" {
		t.Fatalf("calls = %v; want only the informational completion", calls)
	}
	if tracker.get("held") != nil || tracker.get("work") == nil {
		t.Fatal("wrong delivery released: work must stay held until its result")
	}
}

func TestNativeTurnEndKeepsDeliveriesSubmittedDuringTheTurn(t *testing.T) {
	var calls []string
	client := heldDeliveryServer(t, &calls)
	tracker := newChannelTracker(client)
	r := &autoReceiver{client: client, tracker: tracker}
	tracker.receiver = r
	start := time.Now()
	r.releaseAfterNativeTurn(context.Background(), "active", start)
	// Submitted after the busy spell began: this turn cannot have read it.
	tracker.items["held"] = &channelPending{claimID: "claim", cancel: func() {}, nativeAt: start.Add(time.Second)}
	r.releaseAfterNativeTurn(context.Background(), "idle", start.Add(2*time.Second))
	r.releaseAfterNativeTurn(context.Background(), "idle", start.Add(20*time.Second))
	if len(calls) != 0 || tracker.get("held") == nil {
		t.Fatalf("released a delivery the finished turn never saw: %v", calls)
	}
}

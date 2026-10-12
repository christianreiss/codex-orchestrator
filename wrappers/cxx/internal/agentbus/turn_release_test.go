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

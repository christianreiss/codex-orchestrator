package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func ownerFixture(t *testing.T, path string, runs *atomic.Int32) *receiverOwner {
	t.Helper()
	client := &sessionClient{id: "launch", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"stored":true}`))}, nil
	})}}
	tracker := newChannelTracker(client)
	tracker.receiver = &autoReceiver{client: client, tracker: tracker, connected: true, sources: []string{"peer", "portal"}, lastBeatOK: time.Now()}
	o := &receiverOwner{path: path, client: client, tracker: tracker, runReceiver: func(ctx context.Context, _ io.Writer) { runs.Add(1); <-ctx.Done() }}
	tracker.owner = o
	return o
}

func waitOwner(t *testing.T, o *receiverOwner) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !o.isOwner() {
		if time.Now().After(deadline) {
			t.Fatal("receiver owner was not elected")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func ownerTool(name string, args map[string]any) mcpRequest {
	params, _ := json.Marshal(map[string]any{"name": name, "arguments": args})
	return mcpRequest{JSONRPC: "2.0", ID: json.RawMessage(`7`), Method: "tools/call", Params: params}
}

func TestSharedReceiverRoutesFollowerPortalReplyAndListen(t *testing.T) {
	var runs atomic.Int32
	path := filepath.Join(t.TempDir(), "owner.sock")
	owner := ownerFixture(t, path, &runs)
	follower := ownerFixture(t, path, &runs)
	follower.tracker.receiver.connected = false
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); owner.run(ctx, io.Discard) }()
	defer func() { cancel(); <-done }()
	waitOwner(t, owner)
	owner.tracker.receiver.pendingPortal = map[string]any{"message_id": "portal"}
	// Baseline: the answering process cannot own a delivery admitted by its
	// sibling, even though both have the same launch identity and broker.
	if _, err := follower.tracker.receiver.reply(ctx, map[string]any{"message_id": "portal", "content": "handled"}); err == nil || !strings.Contains(err.Error(), "not owned") {
		t.Fatal("fixture did not reproduce the observed ownership failure", err)
	}
	if follower.tracker.receiver.health()["state"] != "unavailable" {
		t.Fatal("fixture did not reproduce split health")
	}
	// Only the owner saw the native instruction. A second process can still
	// report and reply through the exact same receipt state.
	for _, req := range []mcpRequest{
		ownerTool("agent_receiver_status", map[string]any{"message_id": "portal", "status": "working"}),
		ownerTool("agent_receiver_reply", map[string]any{"message_id": "portal", "content": "handled", "summary": "Handled"}),
		ownerTool("agent_listen", map[string]any{}),
	} {
		out := handleMCPRequest(ctx, follower.client, req, false, follower.tracker)
		raw, _ := json.Marshal(out)
		if strings.Contains(string(raw), `"isError":true`) {
			t.Fatal(string(raw))
		}
	}
	if owner.tracker.receiver.pendingPortal != nil {
		t.Fatal("Portal reply did not release the owner's gate")
	}
	if follower.tracker.receiver.pendingPortal != nil || follower.isOwner() || runs.Load() != 1 {
		t.Fatal("follower started an independent receiver")
	}
}

func TestSharedReceiverElectsOnlyOneAndHandsOverAfterExit(t *testing.T) {
	var runs atomic.Int32
	path := filepath.Join(t.TempDir(), "owner.sock")
	first := ownerFixture(t, path, &runs)
	second := ownerFixture(t, path, &runs)
	ctx1, cancel1 := context.WithCancel(context.Background())
	ctx2, cancel2 := context.WithCancel(context.Background())
	done1, done2 := make(chan struct{}), make(chan struct{})
	go func() { defer close(done1); first.run(ctx1, io.Discard) }()
	defer cancel1()
	waitOwner(t, first)
	go func() { defer close(done2); second.run(ctx2, io.Discard) }()
	defer func() { cancel2(); <-done2 }()
	// A follower tool uses the live owner's transport health.
	out := second.forward(ctx2, ownerTool("agent_listen", map[string]any{}))
	raw, _ := json.Marshal(out)
	if !strings.Contains(string(raw), `"status":"automatic"`) || runs.Load() != 1 {
		t.Fatal(string(raw), runs.Load())
	}
	cancel1()
	<-done1
	waitOwner(t, second)
	if runs.Load() != 2 {
		t.Fatal("successor did not start after owner shutdown")
	}
}

func TestSharedReceiverDoesNotRetryUncertainTool(t *testing.T) {
	var calls atomic.Int32
	var runs atomic.Int32
	o := ownerFixture(t, filepath.Join(t.TempDir(), "owner.sock"), &runs)
	// Simulate a server mutation whose response is lost; forwarding must not
	// retry and duplicate the call. The retry advice keeps the same arguments.
	o.client.http.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) { calls.Add(1); return nil, io.ErrUnexpectedEOF })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); o.run(ctx, io.Discard) }()
	defer func() { cancel(); <-done }()
	waitOwner(t, o)
	out := o.forward(ctx, ownerTool("agent_self", map[string]any{}))
	raw, _ := json.Marshal(out)
	if calls.Load() != 1 || !strings.Contains(string(raw), `"isError":true`) {
		t.Fatal(calls.Load(), string(raw))
	}
}

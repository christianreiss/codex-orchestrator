package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestConferenceToolsDoNotReleaseHeldWork(t *testing.T) {
	for _, tool := range []string{"agent_conf_join", "agent_conf_say"} {
		t.Run(tool, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var acks atomic.Int32
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if strings.HasSuffix(req.URL.Path, "/ack") {
					acks.Add(1)
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"conference_id":"room"}`))}, nil
			})}}
			tracker := newChannelTracker(client)
			pending := tracker.track(ctx, "task", "claim", map[string]any{"work_kind": "task", "content": "CONF/1 TASK conference=room\nstill running"})
			_, err := callMCPTool(ctx, client, tracker, tool, map[string]any{"conference_id": "room", "content": "progress update"})
			if err != nil {
				t.Fatal(err)
			}
			if tracker.get("task") != pending || acks.Load() != 0 {
				t.Fatal("conference operation released unrelated held delivery")
			}
		})
	}
}

func TestReceiverHealthRequiresPeerSource(t *testing.T) {
	for _, sources := range [][]string{nil, {"portal"}, {"peer"}, {"peer", "portal"}} {
		r := &autoReceiver{connected: true, sources: sources, lastBeatOK: time.Now()}
		wantReady := false
		for _, source := range sources {
			wantReady = wantReady || source == "peer"
		}
		if (r.health()["state"] == "ready") != wantReady {
			t.Fatalf("sources=%v gave incorrect peer readiness", sources)
		}
		if !wantReady && r.awaitReady(context.Background(), time.Second)["reason"] != "peer_source_unavailable" {
			t.Fatal("missing peer source gave no recovery reason")
		}
	}
}

func TestConferenceControlsDoNotReleaseAnotherRoomsMessage(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := &sessionClient{}
	tracker := newChannelTracker(client)
	pending := tracker.track(ctx, "other-message", "claim", map[string]any{"content": "CONF/1 SAY conference=other\nhello"})
	if err := tracker.completeConference(ctx, "room"); err != nil || tracker.get("other-message") != pending {
		t.Fatal("another room's message was released")
	}
}

func TestInteractiveLostResultSurvivesTerminalRenewal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	renewed := make(chan struct{}, 1)
	var stores atomic.Int32
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		status, body := 200, `{}`
		if strings.HasSuffix(req.URL.Path, "/renew") {
			status, body = 409, `{"code":"agent_messaging_lease_lost","message":"already completed"}`
			renewed <- struct{}{}
		} else if stores.Add(1) == 1 {
			return nil, io.ErrUnexpectedEOF
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	tracker := newChannelTracker(client)
	pending := tracker.track(ctx, "message", "claim")
	args := map[string]any{"message_id": "message", "task_result": map[string]any{"status": "succeeded", "summary": "Checked fixture"}}
	if _, err := callMCPTool(ctx, client, tracker, "agent_task_result", args); err == nil {
		t.Fatal("fixture did not lose its response")
	}
	select {
	case <-renewed:
	case <-ctx.Done():
		t.Fatal("renewal did not run")
	}
	// Let the renew goroutine process the terminal response before the retry.
	time.Sleep(25 * time.Millisecond)
	if tracker.get("message") != pending {
		t.Fatal("terminal renewal discarded an unconfirmed result receipt")
	}
	if err := tracker.completeOutstanding(ctx); err != nil || tracker.get("message") != nil {
		t.Fatalf("same-result retry failed: %v", err)
	}
	if stores.Load() != 2 {
		t.Fatalf("stores=%d; wanted the original result and one retry", stores.Load())
	}
}

func TestInteractiveUncertainReplyCannotBeReplaced(t *testing.T) {
	var bodies []string
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/reply") {
			var body map[string]any
			_ = json.NewDecoder(req.Body).Decode(&body)
			bodies = append(bodies, stringArg(body, "content"))
			return nil, io.ErrUnexpectedEOF
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracker := newChannelTracker(client)
	tracker.track(ctx, "message", "claim")
	for _, content := range []string{"Original result", "Changed result"} {
		_, _ = callMCPTool(ctx, client, tracker, "agent_reply", map[string]any{"message_id": "message", "content": content})
	}
	_ = tracker.completeOutstanding(ctx)
	for _, body := range bodies {
		if body != "Original result" {
			t.Fatalf("uncertain committed reply overwritten by %q", body)
		}
	}
}

func TestReconnectPreservesOutstandingNativeDeliveries(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var abandoned atomic.Int32
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `{"native_session_id":"native"}`
		switch {
		case strings.HasSuffix(req.URL.Path, "/register"):
			body = `{"sources":["peer","portal"]}`
		case strings.HasSuffix(req.URL.Path, "/heartbeat"):
			return nil, errors.New("temporary heartbeat outage")
		case strings.HasSuffix(req.URL.Path, "/ack"):
			abandoned.Add(1)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	tracker := newChannelTracker(client)
	pending := tracker.track(ctx, "peer", "claim")
	r := &autoReceiver{client: client, tracker: tracker, boundNativeID: "native", pendingPortal: map[string]any{"message_id": "portal"}}
	var deliveries atomic.Int32
	r.output = &mcpWriter{w: receiverHealthWriter{r: r, deliveries: &deliveries}}
	if err := r.connection(ctx); err == nil {
		t.Fatal("fixture did not disconnect")
	}
	if r.pendingPortal == nil || tracker.get("peer") != pending || abandoned.Load() != 0 {
		t.Fatalf("transient reconnect abandoned model work: portal=%v peer=%v abandoned=%d", r.pendingPortal, tracker.get("peer"), abandoned.Load())
	}
	if deliveries.Load() != 0 {
		t.Fatal("reconnect replayed an already submitted message")
	}
}

func TestConcurrentListenCannotCompleteAheadOfReply(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	replyStarted, releaseReply := make(chan struct{}), make(chan struct{})
	var replyCalls, ackCalls atomic.Int32
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/reply") {
			if replyCalls.Add(1) == 1 {
				close(replyStarted)
				select {
				case <-releaseReply:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
		} else if strings.HasSuffix(req.URL.Path, "/ack") {
			ackCalls.Add(1)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}}
	tracker := newChannelTracker(client)
	tracker.track(ctx, "message", "claim")
	replied, listened := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := callMCPTool(ctx, client, tracker, "agent_reply", map[string]any{"message_id": "message", "content": "Done"})
		replied <- err
	}()
	<-replyStarted
	go func() { listened <- tracker.completeOutstanding(ctx) }()
	select {
	case err := <-listened:
		close(releaseReply)
		t.Fatalf("listen completed ahead of the in-flight reply: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	close(releaseReply)
	if err := <-replied; err != nil {
		t.Fatal(err)
	}
	if err := <-listened; err != nil {
		t.Fatal(err)
	}
	if replyCalls.Load() != 1 || ackCalls.Load() != 1 {
		t.Fatalf("overlapping mutations: replies=%d acks=%d", replyCalls.Load(), ackCalls.Load())
	}
}

func TestRejectedInteractiveResultCanBeCorrected(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var calls atomic.Int32
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		status := 200
		if calls.Add(1) == 1 {
			status = 400
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}}
	tracker := newChannelTracker(client)
	tracker.track(ctx, "message", "claim")
	for i, status := range []string{"invalid", "succeeded"} {
		_, err := callMCPTool(ctx, client, tracker, "agent_task_result", map[string]any{"message_id": "message", "task_result": map[string]any{"status": status, "summary": "Done"}})
		if (err != nil) != (i == 0) {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
}

func TestRenewalStopsOnRevokedBindingAndAuthorization(t *testing.T) {
	for _, status := range []int{401, 403, 404, 409, 410} {
		if !definitiveChannelRenewalError(&APIError{Status: status, Code: "fixture_revoked"}) {
			t.Errorf("HTTP %d must release a revoked claim", status)
		}
	}
	for _, status := range []int{429, 500, 502, 503, 504} {
		if definitiveChannelRenewalError(&APIError{Status: status, Code: "fixture_transient"}) {
			t.Errorf("HTTP %d must retain claim correlation", status)
		}
	}
}

func TestPortalClosureReleasesGateForPeerReception(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var claims atomic.Int32
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `{"native_session_id":"native"}`
		switch {
		case strings.HasSuffix(req.URL.Path, "/register"):
			body = `{"sources":["peer"]}`
		case strings.HasSuffix(req.URL.Path, "/heartbeat"):
			body = `{"receiver":{"sources":[{"source":"peer"}]}}`
		case strings.HasSuffix(req.URL.Path, "/claim"):
			claims.Add(1)
			cancel()
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	r := &autoReceiver{client: client, tracker: newChannelTracker(client), pendingPortal: map[string]any{"message_id": "portal"}}
	var deliveries atomic.Int32
	r.output = &mcpWriter{w: receiverHealthWriter{r: r, deliveries: &deliveries}}
	_ = r.connection(ctx)
	if claims.Load() != 1 || r.pendingPortal != nil {
		t.Fatal("closed Portal source blocked peer reception")
	}
}

func TestPortalUncertainReplyRetainsOriginalEvent(t *testing.T) {
	var events []string
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/events") {
			data, _ := io.ReadAll(req.Body)
			events = append(events, string(data))
			if len(events) == 1 {
				return nil, io.ErrUnexpectedEOF
			}
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}}
	r := &autoReceiver{client: client, pendingPortal: map[string]any{"message_id": "portal"}}
	args := map[string]any{"message_id": "portal", "content": "Original result", "summary": "Done"}
	if _, err := r.reply(context.Background(), args); err == nil {
		t.Fatal("fixture did not lose event response")
	}
	if _, err := r.reply(context.Background(), map[string]any{"message_id": "portal", "content": "Changed result"}); err == nil {
		t.Fatal("uncertain result was replaced")
	}
	if _, err := r.reply(context.Background(), args); err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0] != events[1] || r.pendingPortal != nil {
		t.Fatalf("original event was not retried exactly: %v", events)
	}
}

func TestPortalAcceptanceRetriesReceiptWithoutHeartbeatDependency(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		calls := 0
		client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if !strings.HasSuffix(req.URL.Path, "/ack") {
				t.Fatal("accepted delivery depends on another network operation")
			}
			calls++
			if calls == 1 {
				return nil, io.ErrUnexpectedEOF
			}
			body := `{"status":"canceled"}`
			if accepted {
				body = `{"status":"accepted"}`
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
		})}}
		r := &autoReceiver{client: client}
		err := r.portalAccept(context.Background(), map[string]any{"message_id": "portal", "lease_owner": "claim"})
		if (err == nil) != accepted || calls != 2 {
			t.Fatalf("accepted=%v calls=%d err=%v", accepted, calls, err)
		}
	}
}

func TestClaudeNewConversationDoesNotInheritOutstandingWork(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var abandoned atomic.Int32
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `{"native_session_id":"new-native"}`
		switch {
		case strings.HasSuffix(req.URL.Path, "/ack"):
			var args map[string]any
			_ = json.NewDecoder(req.Body).Decode(&args)
			if args["outcome"] != "ambiguous" || args["error_code"] != "native_session_changed" {
				t.Errorf("old work not fenced: %v", args)
			}
			abandoned.Add(1)
		case strings.HasSuffix(req.URL.Path, "/register"):
			body = `{"sources":["peer","portal"]}`
		case strings.HasSuffix(req.URL.Path, "/heartbeat"):
			cancel()
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	tracker := newChannelTracker(client)
	tracker.track(ctx, "peer", "claim")
	r := &autoReceiver{client: client, tracker: tracker, boundNativeID: "old-native", pendingPortal: map[string]any{"message_id": "portal"}}
	var deliveries atomic.Int32
	r.output = &mcpWriter{w: receiverHealthWriter{r: r, deliveries: &deliveries}}
	_ = r.connection(ctx)
	if r.boundNativeID != "new-native" || abandoned.Load() != 1 || tracker.get("peer") != nil || r.pendingPortal != nil {
		t.Fatal("native reset inherited work or failed to rebind")
	}
}

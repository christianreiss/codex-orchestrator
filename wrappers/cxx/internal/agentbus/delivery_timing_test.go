package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDeliveryTimingWireValidation(t *testing.T) {
	for _, timing := range []string{"immediate", "after_turn"} {
		body := map[string]any{}
		if err := copyDeliveryTiming(map[string]any{"delivery_timing": timing}, body, false); err != nil || body["delivery_timing"] != timing {
			t.Fatalf("timing lost: %v %v", body, err)
		}
	}
	for _, timing := range []any{"now", nil, 1} {
		if copyDeliveryTiming(map[string]any{"delivery_timing": timing}, map[string]any{}, false) == nil {
			t.Fatalf("accepted invalid %v", timing)
		}
	}
	if copyDeliveryTiming(map[string]any{"delivery_timing": "immediate"}, map[string]any{}, true) == nil {
		t.Fatal("work accepted immediate")
	}
}

func TestNativeImmediateSteersOnlyExpectedTurnOnce(t *testing.T) {
	for _, mode := range []string{"ok", "race", "uncorrelated"} {
		t.Run(mode, func(t *testing.T) {
			var steers atomic.Int32
			socket, methods := fakeCodexAppServer(t, func(method string, params map[string]any) nativeAnswer {
				switch method {
				case "thread/turns/list":
					return nativeAnswer{result: map[string]any{"data": []any{map[string]any{"id": "active-turn", "status": "inProgress"}}}}
				case "turn/steer":
					steers.Add(1)
					if params["expectedTurnId"] != "active-turn" || params["clientUserMessageId"] != "original-delivery" || params["threadId"] != "thread" {
						t.Errorf("lost precondition/correlation: %v", params)
					}
					if mode == "race" {
						return nativeAnswer{err: map[string]any{"code": -32602, "message": "turn no longer active"}}
					}
					if mode == "uncorrelated" {
						return nativeAnswer{result: map[string]any{"turnId": "other"}}
					}
					return nativeAnswer{result: map[string]any{"turnId": "active-turn"}}
				default:
					t.Errorf("unexpected mutation/read: %s", method)
					return nativeAnswer{}
				}
			})
			q, err := openNativeQueue(context.Background(), socket)
			if err != nil {
				t.Fatal(err)
			}
			defer q.close()
			q.thread = "thread"
			turn, err := q.sendImmediate("original-delivery", "information")
			if (mode == "ok") != (err == nil) {
				t.Fatalf("turn=%s err=%v", turn, err)
			}
			if steers.Load() != 1 {
				t.Fatal("steering replayed")
			}
			for _, method := range methods() {
				if method == "turn/start" || method == "turn/interrupt" || method == "thread/queue/add" || method == "thread/queue/start" {
					t.Fatalf("unsafe fallback %s", method)
				}
			}
		})
	}
}

func TestImmediateClaimRetainsExistingWorkAndCapsInformation(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			tracker := newChannelTracker(nil)
			r := &autoReceiver{tracker: tracker, deliveryTimingV1: true, claudeActivity: activityObservation{State: "working", TurnProof: &agentportal.ClaudeTurnProof{State: "active"}}}
			if engine == "codex" {
				r.queue = &nativeQueue{}
			} else if engine == "grok" {
				r.queue = &grokQueue{}
			}
			work := &channelPending{workKind: "request"}
			tracker.items["work"] = work
			want := true // Every adapter has an explicit non-cancelling primitive.
			if r.immediateClaimAllowed("thread_active") != want {
				t.Fatal("wrong engine capability")
			}
			tracker.items["info"] = &channelPending{immediate: true}
			if r.immediateClaimAllowed("thread_active") {
				t.Fatal("second immediate admitted")
			}
			if tracker.items["work"] != work {
				t.Fatal("existing work released")
			}
			delete(tracker.items, "info")
			r.deliveryTimingV1 = false
			if r.immediateClaimAllowed("thread_active") {
				t.Fatal("unnegotiated immediate claim")
			}
		})
	}
}

func TestTimingToolPreservesUUIDAndPayload(t *testing.T) {
	for _, toolName := range []string{"agent_send", "agent_publish"} {
		t.Run(toolName, func(t *testing.T) {
			const id = "11111111-1111-4111-8111-111111111111"
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				var body map[string]any
				_ = json.NewDecoder(req.Body).Decode(&body)
				if body["delivery_timing"] != "immediate" || body["client_message_id"] != id {
					t.Errorf("wire changed %v", body)
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
			})}}
			args := map[string]any{"to": "agent:peer", "topic": "group:sample", "content": "hello", "delivery_timing": "immediate", "client_message_id": id}
			if _, err := callMCPTool(context.Background(), client, newChannelTracker(client), toolName, args); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestBoundaryChangedDefersExactAcceptedClaimWithoutNativeReplay(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	var writes atomic.Int32
	var boundary atomic.Bool
	boundary.Store(true)
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		status, body := 200, `{"message":{"status":"accepted"}}`
		if strings.HasSuffix(req.URL.Path, "channel-deliver") {
			if boundary.Load() {
				status, body = 409, `{"error":{"code":"native_boundary_changed","message":"native turn changed"}}`
			} else {
				writes.Add(1)
				body = `{"delivered":true}`
			}
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	tracker := newChannelTracker(client)
	r := &autoReceiver{client: client, tracker: tracker, deliveryTimingV1: true, claudeActivity: activityObservation{State: "idle", TurnProof: &agentportal.ClaudeTurnProof{State: "idle"}}}
	tracker.receiver = r
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := tracker.trackAdmission(ctx, "info", "original-claim", map[string]any{"kind": "message", "delivery_timing": "after_turn"})
	if err := r.reconcileAdmission(ctx, "info", p); err != nil {
		t.Fatal(err)
	}
	if !p.admissionPending() || p.claimID != "original-claim" || writes.Load() != 0 {
		t.Fatal("known nonsubmission lost claim")
	}
	boundary.Store(false)
	if err := r.reconcileAdmission(ctx, "info", p); err != nil {
		t.Fatal(err)
	}
	if p.admissionPending() || writes.Load() != 1 {
		t.Fatal("accepted information not exposed once")
	}
	if err := r.reconcileAdmission(ctx, "info", p); err != nil {
		t.Fatal(err)
	}
	if writes.Load() != 1 {
		t.Fatal("native replay")
	}
}

func TestUnknownImmediateAdmissionIsNotReplayed(t *testing.T) {
	// A broker write may have succeeded before its HTTP response was lost.
	var calls atomic.Int32
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "channel-deliver") {
			calls.Add(1)
			return nil, io.ErrUnexpectedEOF
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"message":{"status":"accepted"}}`))}, nil
	})}}
	tracker := newChannelTracker(client)
	r := &autoReceiver{client: client, tracker: tracker, deliveryTimingV1: true}
	tracker.receiver = r
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := tracker.trackAdmission(ctx, "info", "claim", map[string]any{"kind": "message", "delivery_timing": "immediate"})
	if err := r.reconcileAdmission(ctx, "info", p); err == nil {
		t.Fatal("unknown native write reported success")
	}
	if tracker.get("info") != nil || calls.Load() != 1 {
		t.Fatal("uncertain native delivery replayable")
	}
	if err := r.reconcileAdmission(ctx, "info", p); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("replayed unknown native admission")
	}
}

func TestGrokImmediateUsesInterjectionNotSendNow(t *testing.T) {
	for _, mode := range []string{"accepted", "unsupported", "unknown"} {
		t.Run(mode, func(t *testing.T) {
			left, right := net.Pipe()
			defer left.Close()
			defer right.Close()
			done := make(chan struct{})
			go func() {
				defer close(done)
				defer right.Close()
				server := &grokQueue{conn: right}
				frame, err := server.read()
				if err != nil {
					return
				}
				var rpc map[string]any
				_ = json.Unmarshal([]byte(stringArg(frame, "payload")), &rpc)
				params, _ := rpc["params"].(map[string]any)
				if stringArg(rpc, "method") != "_x.ai/interject" || params["sessionId"] != "session" || params["interjectionId"] != "original" || params["sendNow"] != nil {
					t.Errorf("unsafe/lost interjection %v", rpc)
				}
				send := func(event map[string]any) {
					raw, _ := json.Marshal(event)
					_ = server.write(map[string]any{"type": "acp", "payload": string(raw)})
				}
				if mode == "unknown" {
					return
				}
				if mode == "unsupported" {
					send(map[string]any{"id": rpc["id"], "error": map[string]any{"code": -32601}})
					return
				}
				send(map[string]any{"id": rpc["id"], "result": map[string]any{"result": map[string]any{"status": "queued"}}})
				// Wrong session and replay notifications cannot certify admission.
				send(map[string]any{"method": "_x.ai/session/interjection", "params": map[string]any{"sessionId": "other", "interjectionId": "original"}})
				send(map[string]any{"method": "_x.ai/session/interjection", "params": map[string]any{"sessionId": "session", "interjectionId": "original", "_meta": map[string]any{"replay": true}}})
				send(map[string]any{"method": "_x.ai/session/interjection", "params": map[string]any{"sessionId": "session", "interjectionId": "original"}})
			}()
			q := &grokQueue{conn: left, thread: "session"}
			_, err := q.sendImmediate("original", "information")
			if (mode == "accepted") != (err == nil) {
				t.Fatalf("mode=%s err=%v", mode, err)
			}
			<-done
		})
	}
}

func TestImmediateTurnBudgetSurvivesEarlyListen(t *testing.T) {
	tracker := newChannelTracker(nil)
	r := &autoReceiver{tracker: tracker, deliveryTimingV1: true, queue: &nativeQueue{}, immediateUsed: true}
	if r.immediateClaimAllowed("thread_active") {
		t.Fatal("empty tracker reopened same-turn immediate budget")
	}
	r.mu.Lock()
	r.immediateUsed = false
	r.mu.Unlock()
	if !r.immediateClaimAllowed("thread_active") {
		t.Fatal("proven next boundary could not reset budget")
	}
}

func TestImmediateCapabilityRequiresPassiveInvalidParamsProof(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"known parser", &nativeRPCError{code: -32602}, true},
		{"older native", &nativeRPCError{code: -32601}, false},
		{"other failure", &nativeRPCError{code: -32000}, false},
		{"transport uncertainty", io.ErrUnexpectedEOF, false},
		{"surprising success", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			got := probeImmediateMethod(func(method string, params any, out any) error {
				calls++
				if method != "turn/steer" || len(params.(map[string]any)) != 0 {
					t.Fatal("probe can reach a native turn")
				}
				return tc.err
			}, "turn/steer")
			if got != tc.want || calls != 1 {
				t.Fatalf("capability=%v calls=%d", got, calls)
			}
		})
	}
}

func TestClaudeTurnProofSeparatesIdleFromReadinessAndTelemetry(t *testing.T) {
	for _, tc := range []struct{ coarse, proof, want string }{
		{"idle", "", "unknown"}, {"idle", "unknown", "unknown"}, {"unknown", "idle", "idle"}, {"waiting", "active", "working"}, {"working", "active", "working"},
	} {
		a := activityObservation{State: tc.coarse}
		if tc.proof != "" {
			a.TurnProof = &agentportal.ClaudeTurnProof{State: tc.proof}
		}
		if got := claudeTurnState(a); got != tc.want {
			t.Fatalf("coarse=%s proof=%s =>%s", tc.coarse, tc.proof, got)
		}
	}
}

func TestImmediateCompletionRequiresExactCompletedSteeredTurn(t *testing.T) {
	for _, tc := range []struct {
		id, status string
		released   bool
	}{
		{"target", "completed", true}, {"other", "completed", false}, {"target", "inProgress", false}, {"target", "failed", false},
	} {
		t.Run(tc.id+tc.status, func(t *testing.T) {
			socket, _ := fakeCodexAppServer(t, func(method string, params map[string]any) nativeAnswer {
				if method != "thread/turns/list" {
					t.Fatalf("unexpected %s", method)
				}
				return nativeAnswer{result: map[string]any{"data": []any{map[string]any{"id": tc.id, "status": tc.status}}}}
			})
			q, err := openNativeQueue(context.Background(), socket)
			if err != nil {
				t.Fatal(err)
			}
			defer q.close()
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
			})}}
			tracker := newChannelTracker(client)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			p := tracker.track(ctx, "info", "claim", map[string]any{"kind": "message"})
			tracker.mu.Lock()
			p.nativeTurn = "target"
			tracker.mu.Unlock()
			work := tracker.track(ctx, "work", "work-claim", map[string]any{"kind": "request"})
			r := &autoReceiver{client: client, tracker: tracker, queue: q}
			if err := r.releaseCompletedImmediate(ctx); err != nil {
				t.Fatal(err)
			}
			if (tracker.get("info") == nil) != tc.released {
				t.Fatal("wrong consumption inference")
			}
			if tracker.get("work") != work {
				t.Fatal("insertion completed existing work")
			}
		})
	}
}

func TestBusyReceiverClaimsOnlyImmediateAndPreservesWork(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "codex")
	t.Setenv("CODEX_HOME", t.TempDir())
	var steers, claims atomic.Int32
	admitted := make(chan struct{}, 1)
	socket, _ := fakeCodexAppServer(t, func(method string, params map[string]any) nativeAnswer {
		switch method {
		case "thread/loaded/list":
			return nativeAnswer{result: map[string]any{"data": []string{"native"}}}
		case "thread/read":
			return nativeAnswer{result: map[string]any{"thread": map[string]any{"id": "native", "source": "cli", "status": map[string]any{"type": "active"}}}}
		case "thread/turns/list":
			return nativeAnswer{result: map[string]any{"data": []any{map[string]any{"id": "existing-turn", "status": "inProgress"}}}}
		case "turn/steer":
			if len(params) == 0 {
				return nativeAnswer{err: map[string]any{"code": -32602}}
			}
			steers.Add(1)
			admitted <- struct{}{}
			return nativeAnswer{result: map[string]any{"turnId": "existing-turn"}}
		default:
			t.Errorf("unexpected native method %s", method)
			return nativeAnswer{}
		}
	})
	t.Setenv("CXX_CODEX_SOCKET", socket)
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `{}`
		switch {
		case strings.HasSuffix(req.URL.Path, "/register"):
			var request map[string]any
			_ = json.NewDecoder(req.Body).Decode(&request)
			caps, _ := request["capabilities"].(map[string]any)
			if caps["delivery_timing_v1"] != true {
				t.Error("native proven capability not advertised")
			}
			body = `{"sources":["peer"],"capabilities":{"delivery_timing_v1":true,"queue_delivery_v1":true}}`
		case strings.HasSuffix(req.URL.Path, "/receiver/claim"):
			claims.Add(1)
			var request map[string]any
			_ = json.NewDecoder(req.Body).Decode(&request)
			if request["immediate_only"] != true || request["informational_only"] != true {
				t.Errorf("busy claim widened: %v", request)
			}
			body = `{"delivery":{"message_id":"immediate","kind":"message","content":"information","delivery_timing":"immediate"}}`
		case strings.HasSuffix(req.URL.Path, "/ack"):
			body = `{"message":{"status":"accepted"}}`
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	tracker := newChannelTracker(client)
	work := tracker.track(ctx, "work", "original-work-claim", map[string]any{"kind": "request"})
	r := &autoReceiver{client: client, tracker: tracker, immediateBudgetInitialized: true}
	tracker.receiver = r
	done := make(chan error, 1)
	go func() { done <- r.connection(ctx) }()
	select {
	case <-admitted:
	case <-ctx.Done():
		t.Fatal("busy immediate never admitted")
	}
	// The held work and consumed busy-spell budget survive ordinary completion
	// of the immediate informational delivery.
	if err := tracker.completePending(ctx, "immediate", tracker.get("immediate")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1100 * time.Millisecond)
	cancel()
	<-done
	if steers.Load() != 1 || claims.Load() != 1 {
		t.Fatalf("same-turn flood: claims=%d steers=%d", claims.Load(), steers.Load())
	}
	if tracker.get("work") != work {
		t.Fatal("existing accepted work released")
	}
}

func TestClaudeProofEmissionRequiresNegotiationAndBootstrapsEpoch(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprint(enabled), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			posts := 0
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				response := `{}`
				if strings.HasSuffix(req.URL.Path, "activity-hook") {
					response = `{"state":"idle","source":"claude-hooks","turn_proof":{"epoch":"epoch","sequence":2,"state":"idle","native_instance_id":"instance","binding_generation":1}}`
				} else {
					posts++
					var body map[string]any
					_ = json.NewDecoder(req.Body).Decode(&body)
					if !enabled {
						if body["turn_proof"] != nil || body["native_instance_id"] != nil {
							t.Error("additive proof broke strict old activity schema")
						}
						cancel()
					} else {
						proof, _ := body["turn_proof"].(map[string]any)
						if posts == 1 && (proof["state"] != "unknown" || proof["sequence"] != float64(2)) {
							t.Errorf("missing unknown epoch bootstrap: %v", body)
						}
						if posts == 1 {
							cancel()
						}
					}
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(response))}, nil
			})}}
			r := &autoReceiver{client: client, deliveryTimingV1: enabled}
			r.observeActivity(ctx, "claude", "native", "generation", 1)
			want := 1
			if enabled {
				want = 1
			}
			if posts != want {
				t.Fatalf("activity posts=%d want=%d", posts, want)
			}
		})
	}
}

func TestImmediateBudgetRestartAndStaleClaudeIdleCannotReopenTurn(t *testing.T) {
	r := &autoReceiver{deliveryTimingV1: true, tracker: newChannelTracker(nil), queue: &nativeQueue{}}
	r.initializeImmediateBudget()
	if r.immediateClaimAllowed("thread_active") {
		t.Fatal("new process assumed previous owner's busy-turn slot unused")
	}
	r.immediateUsed = false       // exact fresh native idle observation
	r.initializeImmediateBudget() // in-process reconnect preserves the observed budget
	if !r.immediateClaimAllowed("thread_active") {
		t.Fatal("reconnect lost fresh idle warmup")
	}
	r.queue = nil
	proof := func(seq uint64, state string) activityObservation {
		return activityObservation{TurnProof: &agentportal.ClaudeTurnProof{Epoch: "epoch", Sequence: seq, State: state}}
	}
	r.immediateUsed = true
	r.observeClaudeTurn(proof(3, "idle")) // cached startup Stop is only a baseline
	if !r.immediateUsed {
		t.Fatal("cached idle rearmed a restarted receiver")
	}
	r.observeClaudeTurn(proof(4, "active"))
	r.finishClaudeImmediateBudget(proof(4, "active").TurnProof)
	r.observeClaudeTurn(proof(3, "idle")) // stale observer response delayed behind guarded write
	if !r.immediateUsed {
		t.Fatal("stale idle reopened current turn budget")
	}
	r.observeClaudeTurn(activityObservation{State: "unknown"})
	if !r.immediateUsed {
		t.Fatal("unknown reopened budget")
	}
	r.observeClaudeTurn(proof(5, "idle"))
	if r.immediateUsed {
		t.Fatal("new Stop did not reopen next turn budget")
	}
}

func TestImmediatePromptKeepsCurrentWorkUntilNaturalTurnBoundary(t *testing.T) {
	for _, kind := range []string{"message", "reply", "publication"} {
		prompt := nativePeerPrompt(map[string]any{"message_id": "update", "kind": kind, "delivery_timing": "immediate", "content": "information"})
		if !strings.Contains(prompt, "continue your current work") || !strings.Contains(prompt, "leave this informational delivery pending") || !strings.Contains(prompt, "only at a natural turn boundary") {
			t.Fatalf("immediate guidance does not preserve current work: %s", prompt)
		}
		if strings.Contains(prompt, "call agent_listen once, then yield") {
			t.Fatal("immediate update ends current work turn")
		}
	}
	ordinary := nativePeerPrompt(map[string]any{"kind": "message", "content": "ordinary", "delivery_timing": "after_turn"})
	if !strings.Contains(ordinary, "call agent_listen once, then yield") {
		t.Fatal("ordinary turn completion behavior changed")
	}
}

func TestImmediateCapabilityRecognizesOnlyObservedCodexParserDiagnostic(t *testing.T) {
	for _, tc := range []struct {
		method string
		rpc    *nativeRPCError
		want   bool
	}{
		{"turn/steer", &nativeRPCError{method: "turn/steer", code: -32600, message: "Invalid request: missing field `threadId`"}, true},
		{"turn/steer", &nativeRPCError{method: "turn/steer", code: -32600, message: "Invalid request"}, false},
		{"turn/steer", &nativeRPCError{method: "turn/steer", code: -32600, message: "Invalid request: missing field `input`"}, false},
		{"turn/steer", &nativeRPCError{method: "_x.ai/interject", code: -32600, message: "Invalid request: missing field `threadId`"}, false},
		{"_x.ai/interject", &nativeRPCError{method: "_x.ai/interject", code: -32600, message: "Invalid request: missing field `threadId`"}, false},
		{"other/method", &nativeRPCError{method: "other/method", code: -32602}, false},
	} {
		if got := probeImmediateMethod(func(string, any, any) error { return tc.rpc }, tc.method); got != tc.want {
			t.Fatalf("method=%s error=%+v got=%v", tc.method, tc.rpc, got)
		}
	}
}

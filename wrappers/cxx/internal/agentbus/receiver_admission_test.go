package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestAuditAcceptedACKResponseLossRetainsRecoveryOwnership(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	var accepted atomic.Int32
	var delivered atomic.Int32
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `{}`
		switch {
		case strings.HasSuffix(req.URL.Path, "/native"):
			body = `{"native_session_id":"native"}`
		case strings.HasSuffix(req.URL.Path, "/register"):
			body = `{"sources":["peer"],"capabilities":{"queue_delivery_v1":true}}`
		case strings.HasSuffix(req.URL.Path, "/receiver/claim"):
			body = `{"delivery":{"message_id":"work","work_kind":"request","kind":"request","content":"authorized work"}}`
		case strings.HasSuffix(req.URL.Path, "/deliveries/work/ack"):
			if accepted.Add(1) <= 2 { // Server durably accepts before both responses are lost.
				return nil, io.ErrUnexpectedEOF
			}
			body = `{"message":{"status":"accepted"}}`
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	tracker := newChannelTracker(client)
	r := &autoReceiver{client: client, tracker: tracker}
	tracker.receiver = r
	r.output = &mcpWriter{w: receiverHealthWriter{r: r, deliveries: &delivered}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := r.connection(ctx)
	if err == nil || accepted.Load() != 2 || delivered.Load() != 0 {
		t.Fatalf("fault injection not reached: err=%v accepted=%d delivered=%d", err, accepted.Load(), delivered.Load())
	}
	if tracker.get("work") == nil {
		t.Fatal("durably accepted work lost local recovery ownership before native submission")
	}
	original := tracker.get("work")
	retryCtx, stopRetry := context.WithTimeout(context.Background(), 2*time.Second)
	defer stopRetry()
	r.output = &mcpWriter{w: admissionWriter{receiverHealthWriter: receiverHealthWriter{r: r, deliveries: &delivered}, cancel: stopRetry}}
	_ = r.connection(retryCtx)
	if accepted.Load() != 3 || delivered.Load() != 1 || tracker.get("work") != original || original.admissionPending() {
		t.Fatalf("reconnect lost exact acceptance correlation or first exposure: accepted=%d delivered=%d", accepted.Load(), delivered.Load())
	}

}

func TestUnconfirmedAdmissionCannotBeCompletedByListenOrOldTurn(t *testing.T) {
	for _, kind := range []string{"request", "message"} {
		t.Run(kind, func(t *testing.T) {
			var acks atomic.Int32
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) { acks.Add(1); return nil, io.ErrUnexpectedEOF })}}
			tracker := newChannelTracker(client)
			r := &autoReceiver{client: client, tracker: tracker}
			tracker.receiver = r
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			delivery := map[string]any{"kind": kind}
			pending := tracker.trackAdmission(ctx, "held", "same-claim", delivery)
			out, err := agentListen(ctx, client, tracker, map[string]any{})
			if err != nil || out["status"] != "delivery_pending" {
				t.Fatalf("unexposed delivery became work or completed: %v %v", out, err)
			}
			if _, err := tracker.releaseSeen(ctx, []string{"held"}); err != nil {
				t.Fatal(err)
			}
			if err := tracker.abandonFailedTurn(ctx, "crash"); err != nil {
				t.Fatal(err)
			}
			if acks.Load() != 0 || tracker.get("held") != pending {
				t.Fatal("unexposed admission was inferred read or failed")
			}
			if err := pending.setCompletion(map[string]any{}); err == nil {
				t.Fatal("unexposed work accepted a task result")
			}
		})
	}
}

type admissionQueue struct {
	sent    atomic.Int32
	busy    atomic.Bool
	sendErr error
}

func (q *admissionQueue) identity() (string, error) { return "native", nil }
func (q *admissionQueue) status() (string, error) {
	if q.busy.Load() {
		return "active", nil
	}
	return "idle", nil
}
func (q *admissionQueue) send(string, string) error { q.sent.Add(1); return q.sendErr }
func (q *admissionQueue) close()                    {}

func TestAdmissionReconciliationUsesExactClaimAndNeverReplaysNative(t *testing.T) {
	for _, engine := range []string{"codex", "grok"} {
		t.Run(engine, func(t *testing.T) {
			t.Setenv("CXX_AGENT_PORTAL_ENGINE", engine)
			var accepted, ambiguous atomic.Int32
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				var body map[string]any
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if body["claim_id"] != "original-claim" {
					t.Errorf("claim identity changed: %v", body)
				}
				if body["outcome"] == "ambiguous" {
					ambiguous.Add(1)
				} else if accepted.Add(1) <= 2 {
					return &http.Response{StatusCode: 409, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"code":"communicator_outcome_unknown"}`))}, nil
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"message":{"status":"accepted"}}`))}, nil
			})}}
			tracker := newChannelTracker(client)
			queue := &admissionQueue{}
			r := &autoReceiver{client: client, tracker: tracker, queue: queue}
			tracker.receiver = r
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			tracker.trackAdmission(ctx, "work", "original-claim", map[string]any{"kind": "request", "content": "do work"})
			if err := r.reconcileAdmissions(ctx); err == nil {
				t.Fatal("lost acceptance was not surfaced")
			}
			if queue.sent.Load() != 0 || tracker.get("work") == nil {
				t.Fatal("unknown acceptance submitted or lost")
			}
			// A newly connected native queue must remain idle before first exposure.
			queue = &admissionQueue{}
			queue.busy.Store(true)
			r.queue = queue
			if err := r.reconcileAdmissions(ctx); err != nil {
				t.Fatal(err)
			}
			if accepted.Load() != 2 || queue.sent.Load() != 0 {
				t.Fatal("busy native thread was used")
			}
			queue.busy.Store(false)
			var wg sync.WaitGroup
			for range 4 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					if err := r.reconcileAdmissions(ctx); err != nil {
						t.Error(err)
					}
				}()
			}
			wg.Wait()
			if queue.sent.Load() != 1 || accepted.Load() != 3 || ambiguous.Load() != 0 || tracker.get("work") == nil {
				t.Fatalf("recovery duplicated or lost accepted work: native=%d accepted=%d", queue.sent.Load(), accepted.Load())
			}
			if err := r.reconcileAdmissions(ctx); err != nil {
				t.Fatal(err)
			}
			if queue.sent.Load() != 1 {
				t.Fatal("confirmed native submission replayed")
			}
		})
	}
}

func TestAdmissionTerminalReceiptNeverSubmitsNative(t *testing.T) {
	for _, response := range []struct {
		status int
		body   string
	}{
		{409, `{"code":"agent_messaging_lease_lost"}`},
		{410, `{"code":"agent_messaging_message_expired"}`},
		{200, `{"message":{"status":"ambiguous"}}`},
		{200, `{"message":{"status":"completed"}}`},
	} {
		t.Run(response.body, func(t *testing.T) {
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: response.status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(response.body))}, nil
			})}}
			tracker := newChannelTracker(client)
			queue := &admissionQueue{}
			r := &autoReceiver{client: client, tracker: tracker, queue: queue}
			tracker.receiver = r
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			tracker.trackAdmission(ctx, "work", "claim", map[string]any{"kind": "request"})
			if err := r.reconcileAdmissions(ctx); err == nil {
				t.Fatal("terminal acceptance verdict not surfaced")
			}
			if queue.sent.Load() != 0 || tracker.get("work") != nil {
				t.Fatal("terminal delivery submitted or kept retrying")
			}
		})
	}
}

func TestUnknownNativeAdmissionIsNeverRetried(t *testing.T) {
	var ambiguous atomic.Int32
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		if body["outcome"] == "ambiguous" {
			ambiguous.Add(1)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"message":{"status":"accepted"}}`))}, nil
	})}}
	tracker := newChannelTracker(client)
	queue := &admissionQueue{sendErr: io.ErrUnexpectedEOF}
	r := &autoReceiver{client: client, tracker: tracker, queue: queue}
	tracker.receiver = r
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracker.trackAdmission(ctx, "work", "claim", map[string]any{"kind": "request"})
	if err := r.reconcileAdmissions(ctx); err == nil {
		t.Fatal("native uncertainty hidden")
	}
	if err := r.reconcileAdmissions(ctx); err != nil {
		t.Fatal(err)
	}
	if queue.sent.Load() != 1 || ambiguous.Load() != 1 || tracker.get("work") != nil {
		t.Fatal("native submission was retried or unknown result invented")
	}
}

type admissionWriter struct {
	receiverHealthWriter
	cancel context.CancelFunc
}

func (w admissionWriter) Write(raw []byte) (int, error) {
	n, err := w.receiverHealthWriter.Write(raw)
	if w.deliveries.Load() > 0 {
		w.cancel()
	}
	return n, err
}

package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

type failedDeliveryQueue struct {
	nativeDelivery
	failure string
}

func (q failedDeliveryQueue) watchdogFailure() (string, string, error) { return q.failure, "", nil }

func TestFailedNativeTurnStopsRenewalWithoutWatchdog(t *testing.T) {
	for _, failure := range []string{"crash", "user_stop"} {
		t.Run(failure, func(t *testing.T) {
			var acks atomic.Int32
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				switch {
				case strings.HasSuffix(req.URL.Path, "/watchdog/get"):
				case strings.HasSuffix(req.URL.Path, "/ack"):
					var body map[string]any
					_ = json.NewDecoder(req.Body).Decode(&body)
					if body["claim_id"] != "claim" || body["outcome"] != "ambiguous" {
						t.Errorf("invented work outcome or lost claim: %v", body)
					}
					acks.Add(1)
				default:
					t.Errorf("unexpected operation: %s", req.URL.Path)
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
			})}}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			tracker := newChannelTracker(client)
			pending := tracker.track(ctx, "held", "claim", map[string]any{"work_kind": "request"})
			stopRenewal := pending.cancel
			renewalStopped := false
			pending.cancel = func() { renewalStopped = true; stopRenewal() }
			receiver := &autoReceiver{client: client, tracker: tracker, queue: failedDeliveryQueue{failure: failure}}
			if err := receiver.observeFailure(ctx, "native"); err != nil {
				t.Fatal(err)
			}
			if acks.Load() != 1 || tracker.get("held") != nil || !renewalStopped {
				t.Fatalf("failed turn still held/renewed: acks=%d stopped=%v", acks.Load(), renewalStopped)
			}
		})
	}
}

func TestFailedNativeTurnPreservesUncertainExplicitResult(t *testing.T) {
	tracker := newChannelTracker(&sessionClient{})
	cancelled := false
	pending := &channelPending{claimID: "claim", cancel: func() { cancelled = true }, completionBody: map[string]any{"task_result": map[string]any{"status": "succeeded"}}}
	tracker.items["held"] = pending
	if err := tracker.abandonFailedTurn(context.Background(), "crash"); err != nil {
		t.Fatal(err)
	}
	if cancelled || tracker.get("held") != pending {
		t.Fatal("native failure discarded an explicit result receipt awaiting retry")
	}
}

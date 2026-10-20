package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSmartListenAllowsCoordinationWithoutCompletingWork(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			t.Setenv("CXX_AGENT_PORTAL_ENGINE", engine)
			var posted []string
			var bodies []map[string]any
			c := heldWorkClient(t, &posted, &bodies)
			tracker := newChannelTracker(c)
			tracker.receiver = &autoReceiver{client: c, tracker: tracker, connected: true, sources: []string{"peer"}, lastBeatOK: time.Now(), queueDeliveryV1: true}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			work := tracker.track(ctx, "work", "work-claim", map[string]any{"work_kind": "request"})
			tracker.track(ctx, "digest", "info-claim", map[string]any{"kind": "digest"})
			out, err := agentListen(ctx, c, tracker, map[string]any{})
			if err != nil || out["status"] != "automatic" || out["coordination_reception"] != true {
				t.Fatalf("coordination unavailable: %v %v", out, err)
			}
			if tracker.get("work") != work || tracker.get("digest") != nil {
				t.Fatal("listen changed accepted work or retained digest")
			}
			if len(posted) != 1 || posted[0] != "deliveries/digest/ack" {
				t.Fatalf("unexpected operations %v", posted)
			}
			report := tracker.heldReport()
			if !report.CoordinationReception || len(report.Held) != 1 {
				t.Fatalf("hook still blocks coordination: %+v", report)
			}
		})
	}
}

func TestDigestPromptFetchesOriginalsAndNeverReplies(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			t.Setenv("CXX_AGENT_PORTAL_ENGINE", engine)
			prompt := nativePeerPrompt(map[string]any{"message_id": "digest", "kind": "digest", "content": `{"entries":[{"message_id":"old"}]}`})
			for _, required := range []string{"previews", "agent_digest_get", "never held work", "Do not reply"} {
				if !strings.Contains(prompt, required) {
					t.Fatalf("missing %s: %s", required, prompt)
				}
			}
		})
	}
}

func TestNegotiatedReceiverClaimsCoordinationWhileHoldingWork(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var delivered, claims atomic.Int32
	var infoOnly atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		out := map[string]any{}
		switch path.Base(req.URL.Path) {
		case "ack":
			out["message"] = map[string]any{"status": "accepted"}
		case "native":
			out["native_session_id"] = "native"
		case "register":
			if body["capabilities"] == nil {
				t.Error("receiver did not advertise queue capability")
			}
			out["sources"] = []string{"peer"}
			out["capabilities"] = map[string]any{"queue_delivery_v1": true}
		case "claim":
			if n := claims.Add(1); n == 1 {
				infoOnly.Store(body["informational_only"] == true)
				out["delivery"] = map[string]any{"message_id": "approval", "kind": "message", "delivery_class": "coordination", "content": "approved"}
			}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer server.Close()
	c := &sessionClient{id: "session", http: &http.Client{Transport: rewriteTransport{server: server}}}
	tracker := newChannelTracker(c)
	tracker.track(ctx, "work", "work-claim", map[string]any{"work_kind": "request"})
	r := &autoReceiver{client: c, tracker: tracker}
	tracker.receiver = r
	r.output = &mcpWriter{w: receiverHealthWriter{r: r, deliveries: &delivered}}
	done := make(chan error, 1)
	go func() { done <- r.connection(ctx) }()
	for delivered.Load() == 0 && ctx.Err() == nil {
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	<-done
	if delivered.Load() != 1 || !infoOnly.Load() || tracker.get("work") == nil {
		t.Fatalf("coordination failed: deliveries=%d onlyInfo=%v", delivered.Load(), infoOnly.Load())
	}
}

func TestQueueCapabilityFallsBackOnlyAfterExplicitOldServerRejection(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var registrations, delivered atomic.Int32
	var firstGeneration atomic.Value
	claimed := make(chan bool, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		out := map[string]any{}
		switch path.Base(req.URL.Path) {
		case "native":
			out["native_session_id"] = "native"
		case "register":
			if registrations.Add(1) == 1 {
				firstGeneration.Store(body["generation"])
				if body["capabilities"] == nil {
					t.Error("missing negotiation")
				}
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"message":"unknown capabilities field"}`))
				return
			}
			if body["capabilities"] != nil || body["generation"] != firstGeneration.Load() {
				t.Error("fallback changed identity or retained unsupported fields")
			}
			out["sources"] = []string{"peer"}
		case "claim":
			select {
			case claimed <- body["informational_only"] == nil:
			default:
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
	select {
	case compatible := <-claimed:
		if !compatible {
			t.Error("legacy claim included unsupported queue metadata")
		}
	case <-ctx.Done():
		t.Error("legacy receiver did not claim")
	}
	cancel()
	<-done
	if registrations.Load() != 2 || r.coordinationEnabled() {
		t.Fatal("legacy receiver incorrectly negotiated smart delivery")
	}
}

func TestQueueNegotiationNeverRetriesAnAmbiguousRegistrationAsLegacy(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	var registrations, delivered atomic.Int32
	c := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if path.Base(req.URL.Path) == "register" {
			registrations.Add(1)
			return nil, errors.New("registration receipt lost")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"native_session_id":"native"}`))}, nil
	})}}
	tracker := newChannelTracker(c)
	r := &autoReceiver{client: c, tracker: tracker}
	tracker.receiver = r
	r.output = &mcpWriter{w: receiverHealthWriter{r: r, deliveries: &delivered}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.connection(ctx); err == nil || registrations.Load() != 1 {
		t.Fatalf("ambiguous registration retried: count=%d error=%v", registrations.Load(), err)
	}
}

func TestQueueMetadataRespectsServerSyntaxIndependentlyOfActivation(t *testing.T) {
	args := map[string]any{"delivery_class": "coordination", "related_work_id": "work"}
	for _, supported := range []bool{false, true} {
		r := &autoReceiver{connected: true, queuePolicyV1: supported}
		state := &channelTracker{receiver: r}
		body := map[string]any{"client_message_id": "stable"}
		copyQueuePolicy(args, body, state)
		if (body["delivery_class"] != nil) != supported || body["client_message_id"] != "stable" {
			t.Fatalf("incompatible request: supported=%v body=%v", supported, body)
		}
	}
}

func TestFullPeerBatchPreservesActionableOriginals(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			t.Setenv("CXX_AGENT_PORTAL_ENGINE", engine)
			prompt := nativePeerPrompt(map[string]any{"message_id": "presentation", "kind": "digest", "content": `{"presentation":"peer_batch_v1","entries":[{"message_id":"question","content":"Which target?"},{"message_id":"advisor","content":"ADVISOR/1 full answer"}]}`})
			for _, required := range []string{"full original messages", "Questions and substantive coordination", "original message_id", "never held work", "Which target?", "ADVISOR/1 full answer"} {
				if !strings.Contains(prompt, required) {
					t.Fatalf("missing %s: %s", required, prompt)
				}
			}
			if strings.Contains(prompt, "Entries are previews") {
				t.Fatal("full content presented as preview")
			}
		})
	}
}

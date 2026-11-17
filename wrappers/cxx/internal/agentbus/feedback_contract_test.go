package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestExplicitSessionPurposeReplacement(t *testing.T) {
	for _, replace := range []bool{false, true} {
		client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			var body struct {
				Payload map[string]any `json:"payload"`
			}
			_ = json.NewDecoder(req.Body).Decode(&body)
			if body.Payload["only_if_missing"] != !replace {
				t.Errorf("replace=%v payload=%v", replace, body.Payload)
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`)), Header: make(http.Header)}, nil
		})}}
		if _, err := assignSessionName(context.Background(), client, map[string]any{"name": "Next task", "replace": replace}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAcceptedResultClaimSchemaAndCorrelation(t *testing.T) {
	for _, name := range []string{"agent_reply", "agent_task_result"} {
		t.Run(name, func(t *testing.T) {
			var catalog []map[string]any
			_ = json.Unmarshal(toolCatalogJSON(), &catalog)
			for _, tool := range catalog {
				if tool["name"] == name {
					props := tool["inputSchema"].(map[string]any)["properties"].(map[string]any)
					if props["claim_id"] == nil {
						t.Error("claim_id missing from schema")
					}
				}
			}
			calls := 0
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				calls++
				var body map[string]any
				_ = json.NewDecoder(req.Body).Decode(&body)
				if body["claim_id"] != "11111111-1111-4111-8111-111111111111" {
					t.Errorf("claim lost: %v", body)
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`)), Header: make(http.Header)}, nil
			})}}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			tracker := newChannelTracker(client)
			args := map[string]any{"message_id": "message", "claim_id": "11111111-1111-4111-8111-111111111111", "content": "Done", "task_result": map[string]any{"status": "succeeded", "summary": "Done"}}
			if _, err := callMCPTool(ctx, client, tracker, name, args); err != nil {
				t.Error(err)
			}
			if calls != 1 {
				t.Errorf("explicit original claim forwarded %d times", calls)
			}
			tracker.track(ctx, "other", "22222222-2222-4222-8222-222222222222")
			args["message_id"] = "other"
			before := calls
			if _, err := callMCPTool(ctx, client, tracker, name, args); err == nil {
				t.Error("mismatched claim accepted")
			}
			if calls != before {
				t.Error("mismatched claim reached server")
			}
		})
	}
}

func TestReceiverExplainsSpentImmediateBudgetWithoutReleasingWork(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "codex")
	tracker := newChannelTracker(nil)
	work := &channelPending{workKind: "request", claimID: "original"}
	tracker.items["work"] = work
	r := &autoReceiver{tracker: tracker, queue: &nativeQueue{}, deliveryTimingV1: true, immediateUsed: true, gate: "held_delivery", connected: true, lastBeatOK: time.Now(), sources: []string{"peer"}}
	health := r.health()
	if health["immediate_admission"] != "budget_exhausted" {
		t.Fatalf("opaque busy receiver: %v", health)
	}
	if !strings.Contains(health["immediate_next_action"].(string), "agent_wait") {
		t.Fatal("missing read-only catch-up route")
	}
	if r.immediateClaimAllowed("held_delivery") || tracker.items["work"] != work {
		t.Fatal("diagnostic changed admission/ownership")
	}
	r.immediateUsed = false
	if got := r.health()["immediate_admission"]; got != "available" {
		t.Fatalf("fresh budget=%v", got)
	}
	r.immediateUnsupported = true
	if got := r.health()["immediate_admission"]; got != "unsupported" {
		t.Fatalf("unsupported=%v", got)
	}
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "kimi")
	if got := r.health()["immediate_admission"]; got != "after_turn_only" {
		t.Fatalf("Kimi=%v", got)
	}
}

func TestExplicitClaimReconciliationDoesNotReplayLostReceipt(t *testing.T) {
	for _, name := range []string{"agent_reply", "agent_task_result"} {
		t.Run(name, func(t *testing.T) {
			var bodies []map[string]any
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				var body map[string]any
				_ = json.NewDecoder(req.Body).Decode(&body)
				bodies = append(bodies, body)
				if len(bodies) == 1 {
					return nil, io.ErrUnexpectedEOF
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`)), Header: make(http.Header)}, nil
			})}}
			tracker := newChannelTracker(client)
			args := map[string]any{"message_id": "message", "claim_id": "11111111-1111-4111-8111-111111111111", "content": "Done", "task_result": map[string]any{"status": "succeeded", "summary": "Done"}}
			if _, err := callMCPTool(context.Background(), client, tracker, name, args); err == nil {
				t.Fatal("lost receipt reported success")
			}
			if len(bodies) != 1 || len(tracker.items) != 0 {
				t.Fatal("uncertain result retried automatically or accepted work recreated")
			}
			if _, err := callMCPTool(context.Background(), client, tracker, name, args); err != nil {
				t.Fatal(err)
			}
			if len(bodies) != 2 || !reflect.DeepEqual(bodies[0], bodies[1]) {
				t.Fatalf("retry changed original result tuple: %v", bodies)
			}
		})
	}
}

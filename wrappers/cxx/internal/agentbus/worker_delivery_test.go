package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestRelayRepliesOnlyWhenAnAnswerIsNeeded(t *testing.T) {
	for _, engine := range []string{config.EngineCodex, config.EngineClaude, config.EngineGrok} {
		for _, tc := range []struct {
			name, kind   string
			answerNeeded bool
		}{
			{"closing", "reply", false},
			{"publication", "publication", false},
			{"followup", "reply", true},
			{"request", "request", true},
		} {
			t.Run(engine+"/"+tc.name, func(t *testing.T) {
				t.Setenv("HOME", t.TempDir())
				oldAdapter := runNativeAdapter
				t.Cleanup(func() { runNativeAdapter = oldAdapter })
				var requests []recordedRequest
				client := &relayClient{id: "relay", token: "fixture", baseURL: "https://relay.invalid"}
				client.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					var body map[string]any
					_ = json.NewDecoder(req.Body).Decode(&body)
					requests = append(requests, recordedRequest{path: req.URL.Path, body: body})
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"message":{"status":"accepted"}}`))}, nil
				})}
				delivery := &relayDelivery{MessageID: "delivery", ClaimID: "claim", Kind: tc.kind, Content: "Thanks, done.", Target: map[string]any{"engine": engine, "address": "agent:target"}}
				runNativeAdapter = func(c *relayClient, ctx context.Context, _ *config.Config, d *relayDelivery, _ string, _ bool) nativeResult {
					if tc.kind != "request" && (!strings.Contains(peerPrompt(d), "Do not acknowledge an acknowledgement") || !strings.Contains(peerPrompt(d), noReplyMarker(d))) {
						t.Fatal("background adapter lost its terminal delivery guidance")
					}
					if err := c.ack(ctx, d, "accepted", "", nil); err != nil {
						return nativeResult{Err: err}
					}
					answer := noReplyMarker(d)
					if tc.answerNeeded {
						answer = "Substantive response"
					}
					return nativeResult{Started: true, Reply: answer, UpstreamSessionID: "native"}
				}
				if err := client.processDelivery(context.Background(), map[string]*config.Config{engine: {Engine: engine}}, delivery); err != nil {
					t.Fatal(err)
				}
				if got := strings.Join(ackOutcomes(requests), ","); got != "accepted,completed" {
					t.Fatalf("closing reply lost lifecycle: %s", got)
				}
				replies := 0
				for _, req := range requests {
					if strings.HasSuffix(req.path, "/reply") {
						replies++
						if req.body["content"] != "Substantive response" {
							t.Fatal("outbound answer lost model content")
						}
					}
				}
				if tc.answerNeeded && replies != 1 || !tc.answerNeeded && replies != 0 {
					t.Fatalf("answerNeeded=%v but outbound replies=%d", tc.answerNeeded, replies)
				}
			})
		}
	}
}

func TestNativeOutputRejectsFailedTurns(t *testing.T) {
	for _, tc := range []struct{ engine, output string }{
		{config.EngineClaude, `{"is_error":true,"result":"The prompt failed","session_id":"s"}`},
		{config.EngineClaude, `{"subtype":"error_max_turns","result":"Partial response","session_id":"s"}`},
		{config.EngineCodex, "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Partial response\"}}\n{\"type\":\"turn.failed\"}\n"},
		{config.EngineGrok, `{"type":"error","text":"Partial response","stopReason":"end_turn","sessionId":"s"}`},
		{config.EngineGrok, `{"text":"Partial response","stopReason":"cancelled","sessionId":"s"}`},
		{config.EngineGrok, `{"text":"Partial response","stopReason":"max_tokens","sessionId":"s"}`},
		{config.EngineGrok, `{"text":"Partial response","stopReason":"max_turn_requests","sessionId":"s"}`},
	} {
		if reply, _ := parseNativeOutput(tc.engine, []byte(tc.output)); reply != "" {
			t.Fatalf("%s failure was published as success: %q", tc.engine, reply)
		}
	}
}

func TestRelayNeverLaunchesForPresenceNotice(t *testing.T) {
	for _, engine := range []string{config.EngineCodex, config.EngineClaude, config.EngineGrok} {
		t.Run(engine, func(t *testing.T) {
			oldAdapter := runNativeAdapter
			t.Cleanup(func() { runNativeAdapter = oldAdapter })
			runNativeAdapter = func(*relayClient, context.Context, *config.Config, *relayDelivery, string, bool) nativeResult {
				t.Fatal("a presence notice must not resume a native agent")
				return nativeResult{}
			}
			var requests []recordedRequest
			client := &relayClient{id: "relay", token: "fixture", baseURL: "https://relay.invalid"}
			client.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				var body map[string]any
				_ = json.NewDecoder(req.Body).Decode(&body)
				requests = append(requests, recordedRequest{path: req.URL.Path, body: body})
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"message":{"status":"dead"}}`))}, nil
			})}
			delivery := &relayDelivery{MessageID: "notice", ClaimID: "claim", Kind: "presence_notice", Target: map[string]any{"engine": engine}}
			if err := client.processDelivery(context.Background(), nil, delivery); err != nil {
				t.Fatal(err)
			}
			if len(requests) != 1 || requests[0].body["outcome"] != "dead" || requests[0].body["error_code"] != "presence_notice_live_session_only" {
				t.Fatalf("unexpected notice outcome: %+v", requests)
			}
		})
	}
}

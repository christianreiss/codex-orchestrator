package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestScheduledPromptIsNotPeerReply(t *testing.T) {
	d := &relayDelivery{Kind: "schedule", Content: "continue the task"}
	if text := peerPrompt(d); !strings.Contains(text, "continue the task") || strings.Contains(text, "Return a concise final response for the sender") {
		t.Fatal(text)
	}
	text := nativePeerPrompt(map[string]any{"kind": "schedule", "content": "continue the task"})
	if !strings.Contains(text, "agent_listen") || strings.Contains(text, "Use agent_reply") {
		t.Fatal(text)
	}
}
func TestScheduleRetryAtReadsStructuredProviderHints(t *testing.T) {
	now := time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)
	if got := scheduleRetryAt(`{"error":{"retry_after_seconds":120}}`, now); got != "2026-10-08T10:02:00Z" {
		t.Fatal(got)
	}
	if got := scheduleRetryAt("provider says maybe tomorrow", now); got != "" {
		t.Fatal(got)
	}
	if got := scheduleRetryAt(`{"reset_at":"2026-10-09T10:00:00Z"}`, now); got != "2026-10-09T10:00:00Z" {
		t.Fatal(got)
	}
}

func TestScheduleRelayUsesStrictResumeAndNeverRepliesToServer(t *testing.T) {
	for _, engine := range []string{config.EngineCodex, config.EngineClaude, config.EngineGrok} {
		for _, missing := range []bool{false, true} {
			t.Run(engine+fmt.Sprint(missing), func(t *testing.T) {
				t.Setenv("HOME", t.TempDir())
				prior := runNativeAdapter
				defer func() { runNativeAdapter = prior }()
				var requests []recordedRequest
				calls := 0
				c := &relayClient{id: "fixture", token: "fixture", baseURL: "https://relay.invalid", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					var body map[string]any
					_ = json.NewDecoder(req.Body).Decode(&body)
					requests = append(requests, recordedRequest{path: req.URL.Path, body: body})
					return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"status":"ok","data":{}}`)), Header: make(http.Header)}, nil
				})}}
				d := &relayDelivery{MessageID: "schedule-message", ClaimID: "claim", Kind: "schedule", Content: "continue", Target: map[string]any{"engine": engine, "address": "agent:fixture", "cwd": "/tmp/fixture", "continuity": "native", "upstream_session_id": "original", "schedule_persistent": true}}
				runNativeAdapter = func(c *relayClient, ctx context.Context, _ *config.Config, d *relayDelivery, upstream string, _ bool) nativeResult {
					calls++
					if upstream != "original" {
						t.Fatal("wrong native session")
					}
					_ = c.ack(ctx, d, "accepted", "", nil)
					if missing {
						return nativeResult{Started: true, MissingTranscript: true, Err: errors.New("missing transcript")}
					}
					return nativeResult{Started: true, Reply: "finished", UpstreamSessionID: "original"}
				}
				err := c.processDelivery(context.Background(), map[string]*config.Config{engine: {Engine: engine}}, d)
				if missing && err == nil || !missing && err != nil {
					t.Fatalf("missing=%v error=%v", missing, err)
				}
				if calls != 1 {
					t.Fatal("fresh fallback attempted")
				}
				for _, request := range requests {
					if strings.HasSuffix(request.path, "/reply") {
						t.Fatal("schedule sent server a peer reply")
					}
				}
				last := requests[len(requests)-1].body
				if missing {
					if last["outcome"] != "dead" || last["error_code"] != "schedule_transcript_missing" {
						t.Fatal(last)
					}
				} else if last["outcome"] != "completed" {
					t.Fatal(last)
				}
			})
		}
	}
}

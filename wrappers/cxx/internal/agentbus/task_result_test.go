package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"testing"
)

func TestTaskOutputNeverInfersSuccess(t *testing.T) {
	for _, raw := range []string{"done", `{"status":"succeeded"}`, `{"content":"done","task_result":{"status":"succeeded","summary":"ok"}} trailing`, `{"content":"done","task_result":{"status":"ok","summary":"ok"}}`} {
		_, report := parseTaskOutput(raw)
		if report.Status != "unknown" {
			t.Fatalf("inferred outcome for %q", raw)
		}
	}
	content, result := parseTaskOutput(`{"content":"Checked file","task_result":{"status":"blocked","summary":"Needs operator input","evidence":[{"description":"file","reference":"/tmp/file"}]}}`)
	if content != "Checked file" || result.Status != "blocked" {
		t.Fatal(content, result)
	}
}
func TestNativeStartRequiresConfirmedAcceptance(t *testing.T) {
	old := startNativeCommand
	defer func() { startNativeCommand = old }()
	for _, confirmed := range []bool{false, true} {
		t.Run(map[bool]string{false: "denied", true: "confirmed"}[confirmed], func(t *testing.T) {
			starts, acks := 0, 0
			startNativeCommand = func(_ *exec.Cmd) error {
				starts++
				if acks == 0 {
					t.Fatal("start before durable acceptance")
				}
				return errors.New("fixture start fails")
			}
			c := &relayClient{id: "relay", baseURL: "https://fixture.invalid", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				var body map[string]any
				_ = json.NewDecoder(req.Body).Decode(&body)
				if body["outcome"] == "accepted" {
					acks++
				}
				status := "canceled"
				if confirmed {
					status = "accepted"
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"message":{"status":"` + status + `"}}`))}, nil
			})}}
			result := c.runNative(context.Background(), &config.Config{}, &relayDelivery{MessageID: "message", ClaimID: "claim", Target: map[string]any{"engine": "codex", "cwd": t.TempDir()}}, "native", false)
			if result.Started || result.Err == nil || (!confirmed && starts != 0) || (confirmed && starts != 1) {
				t.Fatal("unconfirmed execution", starts, result)
			}
		})
	}
}
func TestCompletionFailureRetainsClaimUntilRetry(t *testing.T) {
	fail := true
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if fail {
			return nil, errors.New("network down")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}}
	tracker := newChannelTracker(client)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracker.track(ctx, "message", "claim")
	if tracker.completeOutstanding(ctx) == nil || tracker.get("message") == nil {
		t.Fatal("lost pending completion")
	}
	fail = false
	if err := tracker.completeOutstanding(ctx); err != nil || tracker.get("message") != nil {
		t.Fatal("completion retry failed", err)
	}
}

func TestAllNativeFormatsPreserveTaskOutcome(t *testing.T) {
	report := `{"content":"Fixture verified","task_result":{"status":"succeeded","summary":"Fixture verified","evidence":[{"description":"fixture","reference":"/tmp/fixture"}]}}`
	for _, engine := range []string{config.EngineCodex, config.EngineClaude, config.EngineGrok} {
		t.Run(engine, func(t *testing.T) {
			var output []byte
			switch engine {
			case config.EngineCodex:
				output, _ = json.Marshal(map[string]any{"type": "item.completed", "item": map[string]any{"type": "agent_message", "text": report}})
			case config.EngineClaude:
				output, _ = json.Marshal(map[string]any{"type": "result", "result": report, "session_id": "native"})
			case config.EngineGrok:
				output, _ = json.Marshal(map[string]any{"text": report, "sessionId": "native", "stopReason": "end_turn"})
			}
			text, _ := parseNativeOutput(engine, output)
			content, result := parseTaskOutput(text)
			if content != "Fixture verified" || result.Status != "succeeded" {
				t.Fatalf("%s lost report: %q %+v", engine, text, result)
			}
		})
	}
}

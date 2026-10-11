package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRebootReadinessWaitsForBoundNetworkWithoutRetryingDeniedCredentials(t *testing.T) {
	for _, tc := range []struct {
		code  string
		calls int
	}{
		{"ip_mismatch", 2},
		{"invalid_api_key", 1},
		{"reboot_handoff_conflict", 1},
	} {
		t.Run(tc.code, func(t *testing.T) {
			calls := 0
			err := waitRebootReady(context.Background(), time.Millisecond, func(context.Context) error {
				calls++
				if calls == 1 {
					return &APIError{Status: 401, Code: tc.code}
				}
				return nil
			})
			if calls != tc.calls || (err == nil) != (tc.calls == 2) {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestRebootReadinessIPMismatchCannotWaitPastDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	err := waitRebootReady(ctx, time.Hour, func(context.Context) error {
		calls++
		cancel()
		return &APIError{Status: 401, Code: "ip_mismatch"}
	})
	if calls != 1 || err == nil || !strings.Contains(err.Error(), "readiness deadline") {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}

func TestRebootContinuationRequiresOriginalWorkReceipts(t *testing.T) {
	for _, text := range []string{"agent_task_result", "agent_receiver_reply", "original message ID", "does not store these receipts"} {
		if !strings.Contains(rebootOutputInstruction, text) {
			t.Fatalf("resume guidance lost receipt requirement %q", text)
		}
	}
	if strings.Contains(rebootOutputInstruction, "Do not call agent_reply") {
		t.Fatal("ordinary background-worker guidance suppresses required transferred receipts")
	}
}

func TestRebootRestorePreservesClaimsWithoutReinjecting(t *testing.T) {
	t.Setenv("CXX_REBOOT_REQUEST_ID", "request")
	calls := 0
	client := &sessionClient{id: "new-launch", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if !strings.HasSuffix(req.URL.Path, "/reboot/restore") {
			t.Fatalf("unexpected request %s", req.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"peer":[{"message_id":"original","claim_id":"same-claim","work_kind":"request"}],"portal":{"message_id":"original-portal"}}`))}, nil
	})}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracker := newChannelTracker(client)
	tracker.receiver = &autoReceiver{client: client, tracker: tracker}
	if err := tracker.restoreReboot(ctx); err != nil {
		t.Fatal(err)
	}
	if err := tracker.restoreReboot(ctx); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || tracker.get("original").claimID != "same-claim" || stringArg(tracker.receiver.pendingPortal, "message_id") != "original-portal" {
		t.Fatal("receipt identity was not restored exactly once")
	}
}
func TestRebootTranscriptMissingCannotBecomeFreshSession(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("CODEX_HOME", "")
			t.Setenv("CLAUDE_CONFIG_DIR", "")
			t.Setenv("GROK_HOME", "")
			id := "11111111-1111-4111-8111-111111111111"
			if err := checkRebootTranscript(engine, id); err == nil {
				t.Fatal("missing transcript allowed")
			}
			var path string
			switch engine {
			case "codex":
				path = filepath.Join(home, ".codex", "sessions", "2026", "rollout-test-"+id+".jsonl")
			case "claude":
				path = filepath.Join(home, ".claude", "projects", "test", id+".jsonl")
			case "grok":
				path = filepath.Join(home, ".grok", "sessions", "test", id, "summary.json")
			}
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(map[string]string{"id": id})
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if err := checkRebootTranscript(engine, id); err != nil {
				t.Fatal(err)
			}
			if err := checkRebootTranscript(engine, "22222222-2222-4222-8222-222222222222"); err == nil {
				t.Fatal("different transcript allowed")
			}
			args := nativeArgs(engine, id)
			if !strings.Contains(strings.Join(args, " "), id) {
				t.Fatal("resume lost canonical ID")
			}
		})
	}
}

package agentportal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func busyServer(t *testing.T, holder string, busyCalls int32) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if n <= busyCalls {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
				"message": "Native transcript is already bound to another lifecycle",
				"code":    "agent_messaging_address_busy", "type": "conflict_error",
				"holder_invocation_kind": holder,
			}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"enabled": true, "session_id": body["session_id"], "bridge_token": body["bridge_token"],
			"expires_at": "2026-07-29T12:00:00Z",
			"agent_address": map[string]any{"name": "Hedwig", "address": "agent:11111111-1111-4111-8111-111111111111", "binding_generation": 4},
		})
	}))
	t.Cleanup(server.Close)
	return server, &calls
}

func withHeadlessTiming(t *testing.T, wait, poll time.Duration) {
	t.Helper()
	oldWait, oldPoll := headlessHolderWait, headlessHolderPoll
	headlessHolderWait, headlessHolderPoll = wait, poll
	t.Cleanup(func() { headlessHolderWait, headlessHolderPoll = oldWait, oldPoll })
}

func resumeInput() StartInput {
	return StartInput{Engine: config.EngineClaude, InvocationKind: "interactive", Resumed: true, UpstreamSessionID: "6be82cf6-33e9-4b9e-8161-725a950f806d"}
}

func TestResumeWaitsOutAHeadlessDeliveryTurn(t *testing.T) {
	withHeadlessTiming(t, 5*time.Second, 5*time.Millisecond)
	server, calls := busyServer(t, "peer_delivery", 3)
	session, err := Start(context.Background(), &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "host-fixture"}}, resumeInput())
	if err != nil || session == nil || session.LaunchName != "Hedwig" || calls.Load() != 4 {
		t.Fatalf("resume did not take over after the headless turn: session=%v err=%v calls=%d", session != nil, err, calls.Load())
	}
}

func TestResumeStillRefusesALiveInteractiveHolder(t *testing.T) {
	withHeadlessTiming(t, 5*time.Second, 5*time.Millisecond)
	server, calls := busyServer(t, "interactive", 100)
	session, err := Start(context.Background(), &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "host-fixture"}}, resumeInput())
	if session != nil || !portalErrorCode(err, "agent_messaging_address_busy") || calls.Load() != 1 {
		t.Fatalf("a live terminal holder must refuse at once: session=%v err=%v calls=%d", session != nil, err, calls.Load())
	}
}

func TestResumeGivesUpOnAHeadlessTurnAfterTheWait(t *testing.T) {
	withHeadlessTiming(t, 30*time.Millisecond, 5*time.Millisecond)
	server, _ := busyServer(t, "peer_delivery", 1<<30)
	session, err := Start(context.Background(), &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "host-fixture"}}, resumeInput())
	if session != nil || !headlessHolderBusy(err) {
		t.Fatalf("wait must be bounded: session=%v err=%v", session != nil, err)
	}
}

package agentbus

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestAgentSelfReadsBoundCodexModelAfterModelChange(t *testing.T) {
	const nativeID = "01a1ef7b-8c2c-76b3-81f3-6822a0ad9d55"
	path := filepath.Join(t.TempDir(), "rollout-test-"+nativeID+".jsonl")
	data := `{"type":"turn_context","payload":{"turn_id":"sol-turn","model":"gpt-6.2-sol","effort":"high"}}
{"type":"turn_context","payload":{"turn_id":"astra-turn","model":"gpt-6.2-astra","effort":"medium"}}
{"type":"turn_context","payload":{"turn_id":"different-turn","model":"gpt-6-luna"}}
{"type":"turn_context","payload":{"turn_id":"astra-turn","model":"incomplete"}}
`
	if err := os.WriteFile(path, []byte(data[:len(data)-1]), 0600); err != nil {
		t.Fatal(err)
	}
	var state atomic.Int32
	socket, _ := fakeCodexAppServer(t, func(method string, params map[string]any) nativeAnswer {
		if params["threadId"] != nativeID {
			t.Errorf("read the wrong native thread: %v", params)
		}
		switch method {
		case "thread/read":
			if params["includeTurns"] != false {
				t.Error("read included turn history")
			}
			status := []string{"active", "active", "idle", "notLoaded"}[state.Load()]
			return nativeAnswer{result: map[string]any{"thread": map[string]any{
				"id": nativeID, "model": "gpt-6.2-astra", "reasoningEffort": "medium",
				"status": map[string]any{"type": status}, "path": path,
			}}}
		case "thread/turns/list":
			if params["itemsView"] != "notLoaded" || params["limit"] != float64(1) {
				t.Errorf("latest turn request loaded unnecessary history: %v", params)
			}
			turnID := "sol-turn"
			if state.Load() == 1 {
				turnID = "astra-turn"
			}
			return nativeAnswer{result: map[string]any{"data": []any{map[string]any{
				"id": turnID, "status": "inProgress",
			}}}}
		default:
			t.Errorf("unexpected native RPC %s", method)
			return nativeAnswer{}
		}
	})
	t.Setenv("CXX_CODEX_SOCKET", socket)
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/host/agent-sessions/launch/agent-messaging/self" {
			t.Errorf("unexpected broker route %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"engine": "codex", "native_session_id": nativeID, "name": "Noemi",
		})
	}))
	defer broker.Close()
	client := &sessionClient{id: "launch", http: &http.Client{Transport: rewriteTransport{broker}}}

	cases := []struct {
		id, effort, source, turnID string
	}{
		{"gpt-6.2-sol", "high", "codex_turn_context", "sol-turn"},
		{"gpt-6.2-astra", "medium", "codex_turn_context", "astra-turn"},
		{"gpt-6.2-astra", "medium", "codex_thread_settings", ""},
		{}, // An unloaded binding must not report its saved model after a switch.
	}
	for i, want := range cases {
		state.Store(int32(i))
		out, err := callMCPTool(context.Background(), client, nil, "agent_self", nil)
		if err != nil || out["name"] != "Noemi" {
			t.Fatalf("self read = %v, %v", out, err)
		}
		got, ok := out["session_model"].(*codexSessionModel)
		if !ok {
			t.Fatalf("unexpected model shape: %#v", out["session_model"])
		}
		if want.id == "" {
			if got != nil {
				t.Fatalf("expected unavailable model, got %+v", got)
			}
		} else if got == nil || got.ID != want.id || got.ReasoningEffort != want.effort || got.Source != want.source || got.TurnID != want.turnID {
			t.Fatalf("model = %+v, want %+v", got, want)
		}
	}
}

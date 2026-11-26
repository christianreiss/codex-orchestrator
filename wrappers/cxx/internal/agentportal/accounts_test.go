package agentportal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAccountRouteServesClaudeHandler(t *testing.T) {
	b := &Broker{session: &Session{Engine: "claude"}}
	r := &ConnectionRuntime{broker: b}
	var gotOp, gotArgs string
	r.SetAccountHandler(func(_ context.Context, op string, args json.RawMessage) (any, error) {
		gotOp, gotArgs = op, string(args)
		if op == "switch" {
			return nil, &AccountError{Status: http.StatusConflict, Code: "account_switch_target_unavailable", Message: "paused"}
		}
		return map[string]any{"bound_account_id": 3}, nil
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/agent-messaging/provider-account/status", nil)
	w := httptest.NewRecorder()
	b.accountRequest(w, req, "status", []byte(`{}`))
	if w.Code != 200 || gotOp != "status" || gotArgs != "{}" {
		t.Fatalf("status: %d %s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body["bound_account_id"] != float64(3) {
		t.Fatalf("status body: %s", w.Body.String())
	}
	w = httptest.NewRecorder()
	b.accountRequest(w, req, "switch", []byte(`{"target":9}`))
	if w.Code != http.StatusConflict || !json.Valid(w.Body.Bytes()) {
		t.Fatalf("structured refusal: %d %s", w.Code, w.Body.String())
	}
	r.SetAccountHandler(func(context.Context, string, json.RawMessage) (any, error) { return nil, errors.New("offline") })
	w = httptest.NewRecorder()
	b.accountRequest(w, req, "status", nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("handler failure: %d", w.Code)
	}
}

func TestAccountRouteRefusesOtherEngines(t *testing.T) {
	for _, engine := range []string{"codex", "grok", "kimi", "claude"} {
		b := &Broker{session: &Session{Engine: engine}}
		if engine != "claude" {
			(&ConnectionRuntime{broker: b}).SetAccountHandler(func(context.Context, string, json.RawMessage) (any, error) { return map[string]any{}, nil })
		}
		w := httptest.NewRecorder()
		b.accountRequest(w, httptest.NewRequest(http.MethodPost, "/x", nil), "switch", []byte(`{}`))
		if w.Code != http.StatusConflict {
			t.Fatalf("%s: %d", engine, w.Code)
		}
	}
	if op, ok := isAccountRoute("/v1/agent-messaging/provider-account/switch"); !ok || op != "switch" {
		t.Fatal("switch route not recognised")
	}
	if _, ok := isAccountRoute("/v1/agent-messaging/provider-account/delete"); ok {
		t.Fatal("unknown op accepted")
	}
}

func TestClaudeTurnIdleGuardsWrites(t *testing.T) {
	b := &Broker{session: &Session{Engine: "claude"}, nativeID: "native"}
	r := &ConnectionRuntime{broker: b}
	ran := 0
	write := func() error { ran++; return nil }
	if did, known, _ := r.WhileClaudeTurnIdle(write); !did || known || ran != 1 {
		t.Fatal("without hook evidence the write runs unguarded")
	}
	b.hookActivityAt, b.hookActivityNativeID = time.Now(), "native"
	for _, c := range []struct {
		hook  ActivityHook
		quiet bool
		idle  bool
	}{
		{ActivityHook{Event: "SessionStart", Source: "resume"}, false, false},
		{ActivityHook{Event: "SessionStart", Source: "startup"}, true, true},
		{ActivityHook{Event: "UserPromptSubmit"}, true, false},
		{ActivityHook{Event: "SessionStart", Source: "compact"}, true, false},
		{ActivityHook{Event: "PreToolUse"}, false, false},
		{ActivityHook{Event: "Stop"}, false, true},
		{ActivityHook{Event: "SessionStart", Source: "compact"}, false, true},
	} {
		b.rootTurnIdle = claudeRootTurnIdle(c.hook, b.rootTurnIdle, c.quiet)
		if idle, known := r.ClaudeTurnIdle(); !known || idle != c.idle {
			t.Fatalf("%+v: idle=%v known=%v", c.hook, idle, known)
		}
	}
	b.rootTurnIdle = false
	if did, known, _ := r.WhileClaudeTurnIdle(write); did || !known || ran != 1 {
		t.Fatal("write ran during a turn")
	}
	b.rootTurnIdle = true
	if did, known, _ := r.WhileClaudeTurnIdle(write); !did || !known || ran != 2 {
		t.Fatal("idle write did not run")
	}
}

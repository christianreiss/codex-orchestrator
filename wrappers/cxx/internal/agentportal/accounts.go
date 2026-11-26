package agentportal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// AccountHandler serves the cxx-agent account tools (`account_status`,
// `account_switch`) inside the launching wrapper, which owns the provider
// lease, the API client and the live-switch supervisor. op is "status" or
// "switch". Only a Claude launch registers one.
type AccountHandler func(ctx context.Context, op string, args json.RawMessage) (any, error)

// AccountError carries a structured refusal back to the MCP tool.
type AccountError struct {
	Status  int
	Code    string
	Message string
}

func (e *AccountError) Error() string { return e.Message }

const accountRoutePrefix = "/agent-messaging/provider-account/"

func isAccountRoute(path string) (string, bool) {
	at := strings.LastIndex(path, accountRoutePrefix)
	if at < 0 {
		return "", false
	}
	op := path[at+len(accountRoutePrefix):]
	return op, op == "status" || op == "switch"
}

// SetAccountHandler registers the account tool handler for this launch.
func (r *ConnectionRuntime) SetAccountHandler(h AccountHandler) {
	if r == nil || r.broker == nil {
		return
	}
	r.broker.accountMu.Lock()
	r.broker.accountHandler = h
	r.broker.accountMu.Unlock()
}

func (b *Broker) accountRequest(w http.ResponseWriter, r *http.Request, op string, raw []byte) {
	b.accountMu.Lock()
	handler := b.accountHandler
	b.accountMu.Unlock()
	if b.session.Engine != "claude" || handler == nil {
		writeBrokerError(w, http.StatusConflict, "account_switch_unsupported_engine", "Live account switching is available for Claude sessions only")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	out, err := handler(ctx, op, json.RawMessage(raw))
	if err != nil {
		var accountErr *AccountError
		if errors.As(err, &accountErr) {
			writeBrokerError(w, accountErr.Status, accountErr.Code, accountErr.Message)
			return
		}
		writeBrokerError(w, http.StatusBadGateway, "account_request_failed", err.Error())
		return
	}
	encoded, err := json.Marshal(out)
	if err != nil || len(encoded) == 0 || string(encoded) == "null" {
		encoded = []byte(`{}`)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(encoded)
}

// claudeRootTurnIdle maps one root hook event to "no turn running". Stop and
// StopFailure end a turn. A startup/resume/clear SessionStart is idle when no
// turn was observed before it (or the previous state was idle); a compact
// SessionStart can fire inside a turn and keeps the previous state. Every
// other event (prompt, tool, approval, elicitation, session end) is a turn in
// progress or a process going away.
func claudeRootTurnIdle(h ActivityHook, previous, quiet bool) bool {
	switch h.Event {
	case "Stop", "StopFailure":
		return true
	case "SessionStart":
		switch h.Source {
		case "startup", "resume", "clear":
			return previous || quiet
		}
		return previous
	}
	return false
}

// ClaudeTurnIdle reports whether hook evidence proves that the root Claude
// turn is not running. known is false without hook evidence for the current
// native session (non-receiver launches install no activity hooks).
func (r *ConnectionRuntime) ClaudeTurnIdle() (idle, known bool) {
	if r == nil || r.broker == nil {
		return false, false
	}
	b := r.broker
	b.nativeMu.Lock()
	defer b.nativeMu.Unlock()
	return b.claudeTurnIdleLocked()
}

func (b *Broker) claudeTurnIdleLocked() (idle, known bool) {
	if b.session.Engine != "claude" || b.nativeID == "" || b.hookActivityAt.IsZero() || b.hookActivityNativeID != b.nativeID {
		return false, false
	}
	return b.rootTurnIdle, true
}

// WhileClaudeTurnIdle runs fn while holding the lock every native lifecycle
// hook takes, so a UserPromptSubmit queues behind fn and cannot start a turn
// in between. fn must be short and local (no network). Without hook evidence
// fn runs unguarded (ran=true, known=false) and the caller relies on its own
// heuristic; with evidence of a running turn fn does not run.
func (r *ConnectionRuntime) WhileClaudeTurnIdle(fn func() error) (ran, known bool, err error) {
	if r == nil || r.broker == nil {
		return true, false, fn()
	}
	b := r.broker
	b.nativeMu.Lock()
	defer b.nativeMu.Unlock()
	idle, known := b.claudeTurnIdleLocked()
	if known && !idle {
		return false, true, nil
	}
	return true, known, fn()
}

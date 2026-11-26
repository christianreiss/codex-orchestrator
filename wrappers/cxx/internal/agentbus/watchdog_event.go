package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"time"
)

// Hooks forward only classified status and a retry timestamp. Raw transcript,
// prompts and provider diagnostics never leave this process or reach stdout.
func watchdogHookFailure(v map[string]any) string {
	if stringArg(v, "subagent_type") != "" || stringArg(v, "subagentType") != "" {
		return ""
	}
	event := stringArg(v, "hook_event_name")
	if event == "" {
		event = stringArg(v, "hookEventName")
	}
	switch event {
	case "StopCancelled":
		if stringArg(v, "reason") == "no_progress" {
			return "hang"
		}
		reason := stringArg(v, "reason")
		if reason == "user_interrupt" || reason == "permission_rejected" || reason == "permission_cancelled" {
			return "user_stop"
		}
		if reason == "max_turns" {
			return "blocked"
		}
		return "crash"
	case "SessionEnd":
		reason := stringArg(v, "reason")
		if reason == "prompt_input_exit" || reason == "logout" || reason == "user_interrupt" || reason == "exit" || reason == "clear" {
			return "user_stop"
		}
		return ""
	case "StopFailure":
		kind := stringArg(v, "error")
		if kind == "rate_limit" || kind == "overloaded" {
			return "capacity"
		}
		if kind == "authentication_failed" || kind == "invalid_request" || kind == "billing_error" || kind == "model_not_found" || kind == "account_on_hold" || kind == "oauth_org_not_allowed" || kind == "max_output_tokens" {
			return "blocked"
		}
		text := strings.ToLower(stopFailureText(v))
		if strings.Contains(text, "at capacity") || strings.Contains(text, "overloaded") || strings.Contains(text, "rate limit") || strings.Contains(text, "quota limit") || usageLimitHook() && usageLimitText(text) {
			return "capacity"
		}
		return "crash"
	}
	return ""
}

// stopFailureText is the provider's own wording of a failed turn. It is only
// classified here; none of it is forwarded.
func stopFailureText(v map[string]any) string {
	return strings.Join([]string{stringArg(v, "error_details"), stringArg(v, "errorDetails"), stringArg(v, "last_assistant_message"), stringArg(v, "lastAssistantMessage")}, "\n")
}

// usageLimitHook reports whether this hook runs under the engine whose account
// limits are read here: its server can move the running session to another
// account of the pool. Every other engine that sends StopFailure through this
// command keeps the classification it had.
func usageLimitHook() bool {
	return strings.TrimSpace(os.Getenv("CXX_AGENT_PORTAL_ENGINE")) == "claude"
}

// usageLimitText recognises an account limit in lowercased provider wording:
// "usage limit reached", "You've hit your session limit", "quota limit",
// "rate limit". An organisation's spend cap is a billing matter with no window
// that ends on its own, so it is not one.
func usageLimitText(text string) bool {
	if strings.Contains(text, "spend limit") {
		return false
	}
	if strings.Contains(text, "usage limit") || strings.Contains(text, "quota limit") || strings.Contains(text, "rate limit") {
		return true
	}
	// "hit your limit", "hit your weekly limit", "hit your 5-hour limit".
	for rest := text; ; {
		at := strings.Index(rest, "hit your ")
		if at < 0 {
			return false
		}
		rest = rest[at+len("hit your "):]
		phrase := rest
		if len(phrase) > 32 {
			phrase = phrase[:32]
		}
		if end := strings.IndexAny(phrase, ".\n·"); end >= 0 {
			phrase = phrase[:end]
		}
		if strings.Contains(phrase, "limit") {
			return true
		}
	}
}

// watchdogHookQuotaLimit tells a provider usage limit of the bound account
// from a transient capacity shortage. Only the former says anything about the
// account: the server marks it exhausted and moves the scope to another one.
func watchdogHookQuotaLimit(v map[string]any) bool {
	if !usageLimitHook() || watchdogHookFailure(v) != "capacity" {
		return false
	}
	event := stringArg(v, "hook_event_name")
	if event == "" {
		event = stringArg(v, "hookEventName")
	}
	kind := stringArg(v, "error")
	if event != "StopFailure" || kind == "overloaded" {
		return false
	}
	text := strings.ToLower(stopFailureText(v))
	if strings.Contains(text, "at capacity") || strings.Contains(text, "overloaded") {
		return false
	}
	return kind == "rate_limit" || usageLimitText(text)
}
func reportWatchdogEvent(stdin io.Reader) error {
	raw, e := io.ReadAll(io.LimitReader(stdin, 65537))
	if e != nil || len(raw) > 65536 {
		return nil
	}
	var input map[string]any
	if json.Unmarshal(raw, &input) != nil {
		return nil
	}
	failure := watchdogHookFailure(input)
	if failure == "" {
		return nil
	}
	sessionEnd := stringArg(input, "hook_event_name") == "SessionEnd" || stringArg(input, "hookEventName") == "SessionEnd"
	hookTimeout := 4 * time.Second
	if sessionEnd {
		hookTimeout = time.Second
	}
	client, e := sessionClientFromEnv(hookTimeout)
	if e != nil {
		return nil
	}
	nativeID := stringArg(input, "session_id")
	if nativeID == "" {
		nativeID = stringArg(input, "sessionId")
	}
	if nativeID == "" {
		return nil
	}
	body := map[string]any{"last_progress_at": time.Now().UTC().Format(time.RFC3339Nano), "failure": failure, "native_session_id": nativeID}
	// SessionEnd must not wait on the network while the native CLI is exiting.
	// The supervisor retains the classification and sends it with Finish.
	if sessionEnd {
		body["session_end"] = true
	}
	now := time.Now()
	retry := scheduleRetryAt(string(raw), now)
	if watchdogHookQuotaLimit(input) {
		// Both fields are part of the activity contract since the quota
		// recovery exists; a server without the account marker ignores them
		// unless it has a full window on record, exactly as before.
		body["quota_limit"] = true
		if reset := quotaResetAt(stopFailureText(input), now); reset > retry {
			retry = reset // Both are UTC RFC 3339 to the second: the later one wins.
		}
	}
	if retry != "" {
		body["retry_not_before"] = retry
	}
	ctx, cancel := context.WithTimeout(context.Background(), hookTimeout)
	defer cancel()
	var ignored map[string]any
	_ = client.sessionPost(ctx, "watchdog/activity", body, &ignored)
	return nil // Observation hooks must not change native permission/stop decisions.
}

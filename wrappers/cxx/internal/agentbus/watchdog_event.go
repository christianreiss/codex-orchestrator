package agentbus

import (
	"context"
	"encoding/json"
	"io"
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
		if reason == "user_interrupt" || reason == "permission_rejected" {
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
		text := strings.ToLower(stringArg(v, "error_details") + stringArg(v, "errorDetails") + stringArg(v, "last_assistant_message") + stringArg(v, "lastAssistantMessage"))
		if strings.Contains(text, "at capacity") || strings.Contains(text, "overloaded") || strings.Contains(text, "rate limit") || strings.Contains(text, "quota limit") {
			return "capacity"
		}
		return "crash"
	}
	return ""
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
	client, e := sessionClientFromEnv(4 * time.Second)
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
	if retry := scheduleRetryAt(string(raw), time.Now()); retry != "" {
		body["retry_not_before"] = retry
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	var ignored map[string]any
	_ = client.sessionPost(ctx, "watchdog/activity", body, &ignored)
	return nil // Observation hooks must not change native permission/stop decisions.
}

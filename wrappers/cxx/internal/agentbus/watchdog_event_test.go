package agentbus

import "testing"

func TestWatchdogHookFailuresAcrossEngines(t *testing.T) {
	for _, tc := range []struct {
		v    map[string]any
		want string
	}{
		{map[string]any{"hook_event_name": "StopFailure", "error": "rate_limit"}, "capacity"},
		{map[string]any{"hookEventName": "StopFailure", "error": "overloaded"}, "capacity"},
		{map[string]any{"hookEventName": "StopFailure", "error": "authentication_failed", "errorDetails": "rate limit"}, "blocked"},
		{map[string]any{"hookEventName": "StopFailure", "error": "unknown", "errorDetails": "model at capacity"}, "capacity"},
		{map[string]any{"hookEventName": "StopFailure", "error": "server_error"}, "crash"},
		{map[string]any{"hookEventName": "StopCancelled", "reason": "no_progress"}, "hang"},
		{map[string]any{"hookEventName": "StopCancelled", "reason": "user_interrupt"}, "user_stop"},
		{map[string]any{"hook_event_name": "SessionEnd", "reason": "prompt_input_exit"}, "user_stop"},
		{map[string]any{"hookEventName": "StopFailure", "error": "rate_limit", "subagentType": "helper"}, ""},
		{map[string]any{"hookEventName": "Stop", "lastAssistantMessage": "at capacity"}, ""},
	} {
		if got := watchdogHookFailure(tc.v); got != tc.want {
			t.Errorf("%v got %q want %q", tc.v, got, tc.want)
		}
	}
}

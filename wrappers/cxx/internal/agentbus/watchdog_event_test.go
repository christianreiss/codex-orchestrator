package agentbus

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

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
		{map[string]any{"hookEventName": "StopCancelled", "reason": "permission_cancelled", "cancelledBy": "user"}, "user_stop"},
		{map[string]any{"hookEventName": "StopCancelled", "reason": "unknown"}, "crash"},
		{map[string]any{"hook_event_name": "SessionEnd", "reason": "prompt_input_exit"}, "user_stop"},
		{map[string]any{"hookEventName": "StopFailure", "error": "rate_limit", "subagentType": "helper"}, ""},
		{map[string]any{"hookEventName": "Stop", "lastAssistantMessage": "at capacity"}, ""},
	} {
		if got := watchdogHookFailure(tc.v); got != tc.want {
			t.Errorf("%v got %q want %q", tc.v, got, tc.want)
		}
	}
}

func TestSessionEndHookMarksLocalObservation(t *testing.T) {
	for _, field := range []string{"hook_event_name", "hookEventName"} {
		t.Run(field, func(t *testing.T) {
			var body map[string]any
			commandBroker(t, func(w http.ResponseWriter, r *http.Request) {
				json.NewDecoder(r.Body).Decode(&body)
				io.WriteString(w, `{}`)
			})
			input := `{"` + field + `":"SessionEnd","reason":"exit","session_id":"native"}`
			if err := reportWatchdogEvent(strings.NewReader(input)); err != nil {
				t.Fatal(err)
			}
			if body["session_end"] != true || body["failure"] != "user_stop" || body["native_session_id"] != "native" {
				t.Fatalf("observation=%v", body)
			}
		})
	}
}

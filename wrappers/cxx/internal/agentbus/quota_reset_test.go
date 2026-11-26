package agentbus

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The wording follows Claude Code 2.1.332's own templates: "You've hit your
// <limit>" plus " · resets <time> (<zone>)", where <limit> is one of "limit",
// "session limit", "5-hour limit", "weekly limit", "Opus limit", "Sonnet limit".
func TestWatchdogHookQuotaLimit(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	for _, tc := range []struct {
		name    string
		v       map[string]any
		failure string
		quota   bool
	}{
		{"rate limit error", map[string]any{"hook_event_name": "StopFailure", "error": "rate_limit"}, "capacity", true},
		{"session limit text", map[string]any{"hook_event_name": "StopFailure", "error": "unknown", "last_assistant_message": "You've hit your session limit · resets 3pm (Europe/Berlin)"}, "capacity", true},
		{"weekly limit text", map[string]any{"hookEventName": "StopFailure", "error": "unknown", "lastAssistantMessage": "You've hit your weekly limit · resets Nov 28, 3:30pm (Europe/Berlin)"}, "capacity", true},
		{"plain limit text", map[string]any{"hook_event_name": "StopFailure", "error_details": "You've hit your limit · resets 9am (UTC)"}, "capacity", true},
		{"five hour limit text", map[string]any{"hook_event_name": "StopFailure", "error_details": "You've hit your 5-hour limit"}, "capacity", true},
		{"usage limit text", map[string]any{"hook_event_name": "StopFailure", "error": "unknown", "error_details": "Usage limit reached · resets at 3pm (Europe/Berlin)"}, "capacity", true},
		{"legacy epoch text", map[string]any{"hook_event_name": "StopFailure", "error_details": "Claude AI usage limit reached|1764342000"}, "capacity", true},
		{"quota limit text", map[string]any{"hook_event_name": "StopFailure", "error": "unknown", "errorDetails": "quota limit exceeded"}, "capacity", true},
		{"overloaded error", map[string]any{"hook_event_name": "StopFailure", "error": "overloaded"}, "capacity", false},
		{"overloaded text on a rate limit", map[string]any{"hook_event_name": "StopFailure", "error": "rate_limit", "error_details": "Overloaded"}, "capacity", false},
		{"model at capacity", map[string]any{"hook_event_name": "StopFailure", "error": "unknown", "error_details": "model at capacity"}, "capacity", false},
		{"spend cap is billing", map[string]any{"hook_event_name": "StopFailure", "error": "billing_error", "error_details": "You've hit your monthly spend limit · /usage-credits to raise it"}, "blocked", false},
		{"spend cap without a kind", map[string]any{"hook_event_name": "StopFailure", "error": "unknown", "error_details": "spend limit reached · resets Aug 8"}, "crash", false},
		{"authentication wins over text", map[string]any{"hook_event_name": "StopFailure", "error": "authentication_failed", "error_details": "usage limit"}, "blocked", false},
		{"unrelated hit", map[string]any{"hook_event_name": "StopFailure", "error": "server_error", "error_details": "The request hit your proxy. Its limit is unknown."}, "crash", false},
		{"subagent", map[string]any{"hook_event_name": "StopFailure", "error": "rate_limit", "subagent_type": "helper"}, "", false},
		{"other event", map[string]any{"hook_event_name": "StopCancelled", "reason": "no_progress", "last_assistant_message": "usage limit"}, "hang", false},
		{"ordinary stop", map[string]any{"hook_event_name": "Stop", "last_assistant_message": "You've hit your limit"}, "", false},
	} {
		if got := watchdogHookFailure(tc.v); got != tc.failure {
			t.Errorf("%s: failure %q, want %q", tc.name, got, tc.failure)
		}
		if got := watchdogHookQuotaLimit(tc.v); got != tc.quota {
			t.Errorf("%s: quota limit %v, want %v", tc.name, got, tc.quota)
		}
	}
}

// Grok sends StopFailure through the same command. Without live switching its
// server has no use for an account limit, so nothing about its reports changes.
func TestWatchdogHookLeavesOtherEnginesAlone(t *testing.T) {
	for _, engine := range []string{"grok", "kimi", "codex", ""} {
		t.Setenv("CXX_AGENT_PORTAL_ENGINE", engine)
		for _, tc := range []struct {
			v       map[string]any
			failure string
		}{
			{map[string]any{"hook_event_name": "StopFailure", "error": "rate_limit"}, "capacity"},
			{map[string]any{"hook_event_name": "StopFailure", "error": "unknown", "error_details": "rate limit exceeded"}, "capacity"},
			{map[string]any{"hook_event_name": "StopFailure", "error": "unknown", "error_details": "quota limit exceeded"}, "capacity"},
			{map[string]any{"hook_event_name": "StopFailure", "error": "unknown", "error_details": "You've hit your weekly limit · resets Nov 28, 3pm (UTC)"}, "crash"},
			{map[string]any{"hook_event_name": "StopFailure", "error": "unknown", "error_details": "usage limit reached"}, "crash"},
		} {
			if got := watchdogHookFailure(tc.v); got != tc.failure {
				t.Errorf("%s %v: failure %q, want %q", engine, tc.v, got, tc.failure)
			}
			if watchdogHookQuotaLimit(tc.v) {
				t.Errorf("%s %v: reported as an account limit", engine, tc.v)
			}
		}
	}
	var body map[string]any
	commandBroker(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&body)
		io.WriteString(w, `{}`)
	})
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "grok")
	soon := time.Now().UTC().Add(3 * time.Hour).Truncate(time.Hour)
	raw, _ := json.Marshal(map[string]any{"hook_event_name": "StopFailure", "error": "rate_limit", "session_id": "native",
		"last_assistant_message": "You've hit your limit · resets " + soon.Format("3pm") + " (UTC)"})
	if err := reportWatchdogEvent(strings.NewReader(string(raw))); err != nil {
		t.Fatal(err)
	}
	if body["failure"] != "capacity" {
		t.Fatalf("observation=%v", body)
	}
	for _, key := range []string{"quota_limit", "retry_not_before"} {
		if _, sent := body[key]; sent {
			t.Fatalf("%s left the hook for another engine: %v", key, body)
		}
	}
}

func TestQuotaResetAt(t *testing.T) {
	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Skip("no time zone database on this host")
	}
	// Thursday 2026-11-26 13:10 in Berlin (CET, UTC+1).
	now := time.Date(2026, 11, 26, 13, 10, 0, 0, berlin)
	for _, tc := range []struct{ text, want string }{
		{"You've hit your session limit · resets 3pm (Europe/Berlin)", "2026-11-26T14:00:00Z"},
		{"You've hit your session limit · resets 3:30pm (Europe/Berlin)", "2026-11-26T14:30:00Z"},
		// A clock time that already passed today is tomorrow's.
		{"You've hit your limit · resets 9am (Europe/Berlin)", "2026-11-27T08:00:00Z"},
		{"You've hit your limit · resets 12am (Europe/Berlin)", "2026-11-26T23:00:00Z"},
		{"You've hit your limit · resets 12pm (UTC)", "2026-11-27T12:00:00Z"},
		{"Usage limit reached · resets at 3pm (Europe/Berlin)", "2026-11-26T14:00:00Z"},
		{"You've hit your weekly limit · resets Nov 28, 3pm (Europe/Berlin)", "2026-11-28T14:00:00Z"},
		{"You've hit your weekly limit · resets Dec 1, 9:05am (America/New_York)", "2026-12-01T14:05:00Z"},
		// More than 31 days ahead is no window of a subscription.
		{"You've hit your Opus limit · resets Jan 2, 2027, 9am (UTC)", ""},
		// The legacy form carries epoch seconds: 2026-11-28T15:00:00Z.
		{"Claude AI usage limit reached|1795878000", "2026-11-28T15:00:00Z"},
		// Several resets in one message: the latest never retries too early.
		{"You've hit your session limit · resets 3pm (Europe/Berlin) · your weekly limit resets Nov 28, 3pm (Europe/Berlin)", "2026-11-28T14:00:00Z"},
		// Not placeable exactly, so no reset at all.
		{"You've hit your session limit · resets 3pm", ""},
		{"You've hit your session limit · resets 3pm (Mars/Olympus_Mons)", ""},
		{"You've hit your session limit · resets 3pm (Local)", ""},
		{"spend limit reached · resets Aug 8", ""},
		{"You've hit your weekly limit · resets Nov 20, 3pm (Europe/Berlin)", ""},
		{"You've hit your weekly limit · resets Feb 30, 2027, 3pm (Europe/Berlin)", ""},
		{"You've hit your limit · resets 13pm (Europe/Berlin)", ""},
		{"You've hit your limit · resets 3:75pm (Europe/Berlin)", ""},
		{"Claude AI usage limit reached|1700000000", ""},
		{"Fast limit reached, fast mode paused · resets in 12m", ""},
		{"until your limit resets", ""},
		{"", ""},
	} {
		if got := quotaResetAt(tc.text, now); got != tc.want {
			t.Errorf("%q: %q, want %q", tc.text, got, tc.want)
		}
	}
}

func TestQuotaResetAtAcrossTheYear(t *testing.T) {
	now := time.Date(2026, 12, 30, 22, 0, 0, 0, time.UTC)
	for text, want := range map[string]string{
		"You've hit your Opus limit · resets Jan 2, 2027, 9am (UTC)": "2027-01-02T09:00:00Z",
		// Without a year the date belongs to this one, where it has passed.
		"You've hit your Opus limit · resets Jan 2, 9am (UTC)": "",
		"You've hit your session limit · resets 1am (UTC)":     "2026-12-31T01:00:00Z",
	} {
		if got := quotaResetAt(text, now); got != want {
			t.Errorf("%q: %q, want %q", text, got, want)
		}
	}
}

func TestStopFailureReportsQuotaLimitAndReset(t *testing.T) {
	post := func(input string) map[string]any {
		t.Helper()
		var body map[string]any
		commandBroker(t, func(w http.ResponseWriter, r *http.Request) {
			json.NewDecoder(r.Body).Decode(&body)
			io.WriteString(w, `{}`)
		})
		t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
		if err := reportWatchdogEvent(strings.NewReader(input)); err != nil {
			t.Fatal(err)
		}
		return body
	}
	body := post(`{"hook_event_name":"StopFailure","error":"rate_limit","session_id":"native","last_assistant_message":"You've hit your limit · resets Jan 2, 2099, 9am (UTC)"}`)
	if body["failure"] != "capacity" || body["quota_limit"] != true || body["native_session_id"] != "native" {
		t.Fatalf("observation=%v", body)
	}
	// Beyond the 31-day horizon the printed reset is not believed.
	if _, sent := body["retry_not_before"]; sent {
		t.Fatalf("an implausible reset was forwarded: %v", body)
	}
	for key := range body {
		switch key {
		case "last_progress_at", "failure", "native_session_id", "quota_limit":
		default:
			t.Fatalf("unexpected field %q leaves the hook: %v", key, body)
		}
	}
	soon := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Hour)
	text := "You've hit your weekly limit · resets " + soon.Format("Jan 2, 2006, 3pm") + " (UTC)"
	if soon.Year() == time.Now().UTC().Year() {
		text = "You've hit your weekly limit · resets " + soon.Format("Jan 2, 3pm") + " (UTC)"
	}
	raw, _ := json.Marshal(map[string]any{"hook_event_name": "StopFailure", "error": "rate_limit", "session_id": "native", "last_assistant_message": text})
	body = post(string(raw))
	if body["quota_limit"] != true || body["retry_not_before"] != soon.Format(time.RFC3339) {
		t.Fatalf("observation=%v, want reset %s", body, soon.Format(time.RFC3339))
	}
	// A transient capacity shortage says nothing about the account.
	body = post(`{"hook_event_name":"StopFailure","error":"overloaded","session_id":"native"}`)
	if _, sent := body["quota_limit"]; sent || body["failure"] != "capacity" {
		t.Fatalf("observation=%v", body)
	}
}

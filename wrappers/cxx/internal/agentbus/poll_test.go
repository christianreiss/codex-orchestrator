package agentbus

import (
	"encoding/json"
	"strings"
	"testing"
)

// The Stop hook blocks the turn, and Claude Code ships no `stop_hook_active`
// guard to catch a hook that always blocks. The ledger is the only thing between
// this ringer and a session that can never end its turn, so it gets the tests.

func TestRingLedgerRingsEachMessageOnce(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "11111111-1111-4111-8111-111111111111")

	box := &mailbox{Pending: []mailboxEntry{{MessageID: "m-1"}, {MessageID: "m-2"}}}

	fresh, ledger := unrung(hookEventStop, box)
	if len(fresh) != 2 {
		t.Fatalf("first ring should announce both messages, got %d", len(fresh))
	}
	ledger.commit()

	// A declined call must never ring again: the second Stop has to fall through
	// without blocking, or the turn can never end.
	repeat, _ := unrung(hookEventStop, box)
	if len(repeat) != 0 {
		t.Fatalf("second ring should be silent, got %d entries", len(repeat))
	}
}

func TestRingLedgerIsPerEvent(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "22222222-2222-4222-8222-222222222222")
	box := &mailbox{Pending: []mailboxEntry{{MessageID: "m-1"}}}

	stop, ledger := unrung(hookEventStop, box)
	ledger.commit()
	prompt, promptLedger := unrung(hookEventPrompt, box)
	promptLedger.commit()

	// The two hooks are separate announcements of the same fact; silencing one
	// must not silence the other.
	if len(stop) != 1 || len(prompt) != 1 {
		t.Fatalf("each event rings once: stop=%d prompt=%d", len(stop), len(prompt))
	}
}

func TestRingLedgerFailsClosedWithoutASession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "")
	box := &mailbox{Pending: []mailboxEntry{{MessageID: "m-1"}}}

	fresh, ledger := unrung(hookEventStop, box)
	// No ledger means no way to remember having rung, so it must not ring at
	// all. A missed call is recoverable; a wedged session is not.
	if len(fresh) != 0 || ledger.enabled {
		t.Fatalf("a ledger-less ring must stay silent, got %d entries (enabled=%v)", len(fresh), ledger.enabled)
	}
}

func TestRingLedgerRejectsUnsafeSessionNames(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "../../etc/passwd")

	// The id comes from the wrapper's own environment, but it reaches the
	// filesystem as a path element, so it is checked rather than trusted.
	if _, err := ringLedgerPath(); err == nil {
		t.Fatal("a session id containing path separators must not become a ledger path")
	}
}

func TestStopHookBlocksWithBothAudiences(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "33333333-3333-4333-8333-333333333333")
	box := &mailbox{Pending: []mailboxEntry{{
		MessageID: "m-1",
		From:      mailboxPeer{Address: "agent:abc", Alias: "web02", Engine: "claude", FQDN: "web02.example"},
		ExpiresAt: "2999-01-01T00:00:00Z",
	}}}

	var out strings.Builder
	if err := emitHook(&out, hookEventStop, box); err != nil {
		t.Fatalf("emitHook: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(out.String()), &payload); err != nil {
		t.Fatalf("hook output is not JSON: %v (%q)", err, out.String())
	}
	if payload["decision"] != "block" {
		t.Fatalf("Stop must block to reach anyone at all, got %v", payload["decision"])
	}
	reason, _ := payload["reason"].(string)
	if !strings.Contains(reason, "web02") {
		t.Fatalf("the agent should be told who is calling, got %q", reason)
	}
	// The human is the one who decides whether to take the call, so the ring has
	// to reach them too, not only the model.
	if human, _ := payload["systemMessage"].(string); !strings.Contains(human, "web02") {
		t.Fatalf("the operator should see the caller, got %q", human)
	}
}

func TestPromptHookInjectsContextWithoutBlocking(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "44444444-4444-4444-8444-444444444444")
	box := &mailbox{Pending: []mailboxEntry{{MessageID: "m-1", From: mailboxPeer{Alias: "db01"}}}}

	var out strings.Builder
	if err := emitHook(&out, hookEventPrompt, box); err != nil {
		t.Fatalf("emitHook: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(out.String()), &payload); err != nil {
		t.Fatalf("hook output is not JSON: %v", err)
	}
	if _, blocked := payload["decision"]; blocked {
		t.Fatal("UserPromptSubmit must never block: blocking there erases the user's prompt")
	}
	specific, _ := payload["hookSpecificOutput"].(map[string]any)
	if specific["hookEventName"] != hookEventPrompt {
		t.Fatalf("hookSpecificOutput must name its event, got %v", specific["hookEventName"])
	}
	if context, _ := specific["additionalContext"].(string); !strings.Contains(context, "db01") {
		t.Fatalf("context should name the caller, got %q", context)
	}
}

func TestEmitHookStaysSilentOnAnEmptyMailbox(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "55555555-5555-4555-8555-555555555555")

	var out strings.Builder
	if err := emitHook(&out, hookEventStop, &mailbox{}); err != nil {
		t.Fatalf("emitHook: %v", err)
	}
	// Empty stdout with exit 0 is "no decision" — the turn ends normally.
	if out.Len() != 0 {
		t.Fatalf("nothing waiting must print nothing, got %q", out.String())
	}
}

func TestMissedCallsRingOnceThenStayQuiet(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "66666666-6666-4666-8666-666666666666")
	box := &mailbox{Missed: []mailboxEntry{{
		From:      mailboxPeer{Address: "agent:abc", Alias: "lab03"},
		ExpiredAt: "2026-08-04T14:02:00Z",
	}}}

	fresh, ledger := unrung(hookEventStop, box)
	if len(fresh) != 1 {
		t.Fatalf("a missed call should be reported once, got %d", len(fresh))
	}
	ledger.commit()
	// An expired message carries no id, so the key is who called and when.
	again, _ := unrung(hookEventStop, box)
	if len(again) != 0 {
		t.Fatalf("a missed call must not be reported twice, got %d", len(again))
	}
}

func TestPeerNameFallsBackFromAliasToHost(t *testing.T) {
	cases := []struct {
		peer mailboxPeer
		want string
	}{
		{mailboxPeer{Address: "agent:abc", Alias: "web02", FQDN: "web02.example"}, "web02"},
		{mailboxPeer{Address: "agent:abc", FQDN: "web02.example"}, "web02.example"},
		{mailboxPeer{Address: "agent:abc"}, "agent:abc"},
	}
	for _, tc := range cases {
		if got := tc.peer.name(); got != tc.want {
			t.Errorf("name() = %q, want %q", got, tc.want)
		}
	}
}

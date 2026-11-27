package agentbus

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountgate"
)

// A Stop this hook blocks is followed by a model request without a prompt
// hook. The account gate has to hear about it, or a switch would count the
// session as resting.
func TestBlockedStopTellsTheAccountGate(t *testing.T) {
	dir := accountgate.Dir(t.TempDir(), "lease")
	if err := accountgate.Prepare(dir); err != nil {
		t.Fatal(err)
	}
	t.Setenv(accountgate.EnvDir, dir)
	payload := []byte(`{"hook_event_name":"Stop","session_id":"s1"}`)
	accountgate.Hook(dir, accountgate.HookInput{Event: "UserPromptSubmit", SessionID: "s1"})
	accountgate.Hook(dir, accountgate.HookInput{Event: "Stop", SessionID: "s1"})
	_ = accountgate.Activate(dir, accountgate.Pause{Round: "r1", Deadline: time.Now().Add(time.Minute)})
	if safe, why := accountgate.Safe(dir, "r1", time.Now()); !safe {
		t.Fatalf("an ended turn is not at rest: %s", why)
	}

	var out bytes.Buffer
	spy := &stopBlockSpy{out: &out}
	if err := json.NewEncoder(spy).Encode(map[string]any{"decision": "block", "reason": "you have mail"}); err != nil {
		t.Fatal(err)
	}
	if !spy.blocked() || out.Len() == 0 {
		t.Fatalf("block not seen or not passed through: %q", out.String())
	}
	noteStopBlocked(payload)
	if safe, _ := accountgate.Safe(dir, "r1", time.Now()); safe {
		t.Fatal("a turn that continues after a blocked Stop counts as at rest")
	}

	// A Stop that is let through says nothing.
	quiet := &stopBlockSpy{out: &bytes.Buffer{}}
	if quiet.blocked() {
		t.Fatal("an empty hook answer was read as a block")
	}
	_, _ = quiet.Write([]byte(`{"systemMessage":"x"}`))
	if quiet.blocked() {
		t.Fatal("a hook answer without a decision was read as a block")
	}
}

package agentbus

import (
	"strings"
	"testing"
)

// A background subagent keeps firing tool hooks after the root Stop; they must
// never reach the broker as root turn activity.
func TestSubagentHooksAreNotRootTurnActivity(t *testing.T) {
	t.Setenv(envSocket, "")
	t.Setenv(envSessionID, "")
	sub := `{"session_id":"s","hook_event_name":"PostToolUse","tool_name":"Bash","agent_id":"a1","agent_type":"general-purpose"}`
	if err := reportActivityHook(strings.NewReader(sub)); err != nil {
		t.Fatalf("subagent hook must be dropped before any broker call: %v", err)
	}
	root := `{"session_id":"s","hook_event_name":"PostToolUse","tool_name":"Bash"}`
	if err := reportActivityHook(strings.NewReader(root)); err == nil {
		t.Fatal("root hook should have tried the (absent) broker")
	}
}

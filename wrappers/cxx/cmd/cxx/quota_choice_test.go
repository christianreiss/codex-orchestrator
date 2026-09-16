package main

import (
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/quotaadvice"
	"io"
	"reflect"
	"testing"
)

func TestQuotaSwitchDispatchesOnceWithFreshArguments(t *testing.T) {
	calls := []string{}
	code := dispatchChoice("codex", []string{"resume", "session-id"}, io.Discard, io.Discard, func(engine string, args []string, s *quotaadvice.Session) int {
		calls = append(calls, engine)
		if len(calls) == 1 {
			s.Request = "claude"
			return 0
		}
		if !s.Selected || !reflect.DeepEqual(args, []string{"run"}) {
			t.Fatal("forwarded resume/options or lost selection guard")
		}
		s.Started = true
		s.Request = "codex" // A target cannot trigger a switch loop.
		return 42
	})
	if code != 42 || !reflect.DeepEqual(calls, []string{"codex", "claude"}) {
		t.Fatalf("%d %+v", code, calls)
	}
}
func TestFailedSourceCleanupCannotSwitch(t *testing.T) {
	calls := 0
	code := dispatchChoice("claude", []string{"run"}, io.Discard, io.Discard, func(_ string, _ []string, s *quotaadvice.Session) int { calls++; s.Request = "codex"; return 1 })
	if code != 1 || calls != 1 {
		t.Fatal("switch survived failed cleanup")
	}
}

package nativewriter

import (
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"testing"
)

func TestInteractiveAndRecoveryShareExclusiveNativeWriter(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	first, err := Acquire("codex", "native")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire("codex", "native"); !errors.Is(err, ipc.ErrHeld) {
		t.Fatal("parallel native writer allowed", err)
	}
	different, err := Acquire("claude", "native")
	if err != nil {
		t.Fatal(err)
	}
	different.Release()
	first.Release()
	next, err := Acquire("codex", "native")
	if err != nil {
		t.Fatal("recovery cannot acquire released writer", err)
	}
	next.Release()
}

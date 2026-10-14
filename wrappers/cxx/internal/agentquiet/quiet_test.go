package agentquiet

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
)

func TestBusyFollowsTheNativeLaunchGuard(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	t.Setenv("GROK_HOME", "")
	if got := Busy(); len(got) != 0 {
		t.Fatalf("no native homes must be quiet, got %v", got)
	}
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := Busy(); len(got) != 0 {
		t.Fatalf("an idle native home must be quiet, got %v", got)
	}
	guard, err := sessionguard.Launch("claude")
	if err != nil {
		t.Fatal(err)
	}
	if got := Busy(); len(got) != 1 || got[0] != "claude" {
		t.Fatalf("a running claude session must be busy, got %v", got)
	}
	_ = guard.Release()
	if got := Busy(); len(got) != 0 {
		t.Fatalf("released guard must be quiet again, got %v", got)
	}
}

package agentquiet

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
)

func grokHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	t.Setenv("GROK_HOME", "")
	root := filepath.Join(home, ".grok")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	return root
}

// grok.NewRuntime holds the housekeeping guard only while it builds the private
// runtime; the session's lifetime lease is .cgx-sessions.lock. The gate must
// follow that lease, not the already released launch guard.
func TestBusySeesARunningGrokSession(t *testing.T) {
	root := grokHome(t)
	if got := Busy(); len(got) != 0 {
		t.Fatalf("an idle grok home must be quiet, got %v", got)
	}
	lease, err := ipc.TryAcquireSharedPath(filepath.Join(root, ".cgx-sessions.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if got := Busy(); len(got) != 1 || got[0] != "grok" {
		t.Fatalf("a running grok session must be busy, got %v", got)
	}
	// A second concurrent session keeps it busy after the first one ends.
	second, err := ipc.TryAcquireSharedPath(filepath.Join(root, ".cgx-sessions.lock"))
	if err != nil {
		t.Fatal(err)
	}
	_ = lease.Release()
	if got := Busy(); len(got) != 1 || got[0] != "grok" {
		t.Fatalf("one remaining grok session must keep the gate busy, got %v", got)
	}
	_ = second.Release()
	if got := Busy(); len(got) != 0 {
		t.Fatalf("released grok leases must be quiet again, got %v", got)
	}
}

// A lease file whose holders are gone (clean exit, crash, reaped orphan leader)
// proves nothing: only a held flock counts, never the file or its age, so a
// dead session can never block the gate.
func TestBusyIgnoresAStaleGrokSessionLeaseFile(t *testing.T) {
	root := grokHome(t)
	path := filepath.Join(root, ".cgx-sessions.lock")
	lease, err := ipc.TryAcquireSharedPath(path)
	if err != nil {
		t.Fatal(err)
	}
	_ = lease.Release()
	old := time.Now().Add(-30 * 24 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	if got := Busy(); len(got) != 0 {
		t.Fatalf("an unheld, ancient lease file must be quiet, got %v", got)
	}
}

// cgx's clean exit unlocks the shared open file description, so a detached
// leader that kept a duplicated descriptor holds no flock and never closes the
// gate (the Grok orphan reaper removes it separately).
func TestBusyIgnoresAnOrphanKeepingOnlyTheDescriptor(t *testing.T) {
	root := grokHome(t)
	lease, err := ipc.TryAcquireSharedPath(filepath.Join(root, ".cgx-sessions.lock"))
	if err != nil {
		t.Fatal(err)
	}
	dup, err := lease.DuplicateForExec()
	if err != nil {
		t.Fatal(err)
	}
	defer dup.Release()
	if got := Busy(); len(got) != 1 || got[0] != "grok" {
		t.Fatalf("the live session must be busy, got %v", got)
	}
	_ = lease.Release()
	if got := Busy(); len(got) != 0 {
		t.Fatalf("a leftover descriptor without a flock must be quiet, got %v", got)
	}
}

func TestBusyReportsAnEngineOnceWhenBothGrokLocksAreHeld(t *testing.T) {
	root := grokHome(t)
	launch, err := sessionguard.Launch("grok")
	if err != nil {
		t.Fatal(err)
	}
	defer launch.Release()
	lease, err := ipc.TryAcquireSharedPath(filepath.Join(root, ".cgx-sessions.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if got := Busy(); len(got) != 1 || got[0] != "grok" {
		t.Fatalf("want exactly [grok], got %v", got)
	}
}

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

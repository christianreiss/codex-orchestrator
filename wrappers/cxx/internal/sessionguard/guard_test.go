package sessionguard

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

func TestManagedClaudeUsesDefaultHomeDespiteForeignConfigDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, "foreign-account"))
	root, err := Root("claude")
	if err != nil || root != filepath.Join(home, ".claude") {
		t.Fatalf("native root = %q, %v", root, err)
	}
	lease, err := Maintenance(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Launch("claude"); !errors.Is(err, ipc.ErrHeld) {
		t.Fatalf("launch escaped maintenance fence: %v", err)
	}
	lease.Release()
	if err := os.MkdirAll(filepath.Join(root, ".cxx-housekeeping"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".cxx-housekeeping/journal.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Launch("claude"); err == nil {
		t.Fatal("launch escaped recovery fence")
	}
}

func TestGrokSessionActiveProbesWithoutCreatingTheLeaseFile(t *testing.T) {
	root := t.TempDir()
	if active, err := GrokSessionActive(root); active || err != nil {
		t.Fatalf("no lease file = %v, %v", active, err)
	}
	if _, err := os.Lstat(filepath.Join(root, GrokSessionsLockName)); !os.IsNotExist(err) {
		t.Fatalf("probe created the lease file: %v", err)
	}
	lease, err := ipc.TryAcquireSharedPath(filepath.Join(root, GrokSessionsLockName))
	if err != nil {
		t.Fatal(err)
	}
	if active, err := GrokSessionActive(root); !active || err != nil {
		t.Fatalf("held lease = %v, %v", active, err)
	}
	lease.Release()
	if active, err := GrokSessionActive(root); active || err != nil {
		t.Fatalf("released lease = %v, %v", active, err)
	}
}

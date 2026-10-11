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

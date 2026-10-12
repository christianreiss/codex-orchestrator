package launchpad

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestClaudeLocalPreferencesReadsNativePerModelEffort(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"model":"claude-opus-5-5","effortLevel":"low","modelSettings":{"claude-opus-5-5":{"effortLevel":"xhigh"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	model, effort := LocalPreferences(config.EngineClaude)
	if model != "claude-opus-5-5" || effort != "xhigh" {
		t.Fatalf("picker preferences = %q / %q", model, effort)
	}
}

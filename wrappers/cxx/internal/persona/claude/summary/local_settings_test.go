package summary

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLocalClaudePreferences(t *testing.T) {
	t.Setenv("ANTHROPIC_MODEL", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"model":" claude-sonnet-5 ","effortLevel":" high "}`), 0o600); err != nil {
		t.Fatal(err)
	}

	model, effort := localClaudePreferences()
	if model != "claude-sonnet-5" || effort != "high" {
		t.Fatalf("localClaudePreferences() = %q, %q", model, effort)
	}
}

func TestLocalClaudePreferencesIgnoresInvalidOrMissingSettings(t *testing.T) {
	t.Setenv("ANTHROPIC_MODEL", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	if model, effort := localClaudePreferences(); model != "" || effort != "" {
		t.Fatalf("missing settings = %q, %q", model, effort)
	}

	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"model":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if model, effort := localClaudePreferences(); model != "" || effort != "" {
		t.Fatalf("invalid settings = %q, %q", model, effort)
	}
}

func TestInheritedClaudeModelIsTrimmed(t *testing.T) {
	t.Setenv("ANTHROPIC_MODEL", "  claude-opus-env  ")
	if got := inheritedClaudeModel(); got != "claude-opus-env" {
		t.Fatalf("inheritedClaudeModel() = %q", got)
	}
}

package summary

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLocalCodexPreferences(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte("model = \" gpt-5.6-terra \"\nmodel_reasoning_effort = \" ultra \"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	model, effort := localCodexPreferences()
	if model != "gpt-5.6-terra" || effort != "ultra" {
		t.Fatalf("localCodexPreferences() = %q, %q", model, effort)
	}
}

func TestLocalCodexPreferencesIgnoresInvalidOrMissingConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if model, effort := localCodexPreferences(); model != "" || effort != "" {
		t.Fatalf("missing config = %q, %q", model, effort)
	}
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "config.toml"), []byte("model = ["), 0o600); err != nil {
		t.Fatal(err)
	}
	if model, effort := localCodexPreferences(); model != "" || effort != "" {
		t.Fatalf("invalid config = %q, %q", model, effort)
	}
}

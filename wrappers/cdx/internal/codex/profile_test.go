package codex

import (
	"os"
	"path/filepath"
	"testing"
)

func writeConfig(t *testing.T, body string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestHasProfileBareSection(t *testing.T) {
	writeConfig(t, `model = "gpt-5"

[profiles.dev]
model = "gpt-5-mini"
`)
	if !HasProfile("dev") {
		t.Fatal("expected dev profile to be detected")
	}
	if HasProfile("missing") {
		t.Fatal("missing profile must not match")
	}
}

func TestHasProfileDoubleBracket(t *testing.T) {
	writeConfig(t, `[[profiles.experiment]]
model = "x"
`)
	if !HasProfile("experiment") {
		t.Fatal("expected double-bracket profile to be detected")
	}
}

func TestHasProfileIgnoresCommentsAndWhitespace(t *testing.T) {
	writeConfig(t, `# [profiles.commented]
   [profiles.spaced]
`)
	if HasProfile("commented") {
		t.Fatal("commented profile must not match")
	}
	if !HasProfile("spaced") {
		t.Fatal("whitespace around header must not prevent match")
	}
}

func TestHasProfileEmpty(t *testing.T) {
	if HasProfile("") {
		t.Fatal("empty name must not match anything")
	}
}

func TestHasProfileNoConfigFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if HasProfile("anything") {
		t.Fatal("missing config.toml must not match")
	}
}

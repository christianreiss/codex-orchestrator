package lifecycle

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureOnboardingStateSeedsAbsentFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".claude.json")

	ensureOnboardingState(slog.Default())

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("seed must create .claude.json: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("fresh .claude.json carries oauth state, want mode 0600, got %v", fi.Mode().Perm())
	}
	m := parseObj(t, readFile(t, path))
	if m["hasCompletedOnboarding"] != true {
		t.Errorf("seeded file must set the flag, got %v", m)
	}
	if len(m) != 1 {
		t.Errorf("seed must add only the one key, got %v", m)
	}
}

// An existing-but-unreadable ~/.claude.json must be left alone: dropping the read
// error would make it indistinguishable from an absent file and clobber every key.
func TestEnsureOnboardingStateSkipsUnreadableFile(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads 0000 files, so the unreadable case cannot be simulated")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".claude.json")
	original := []byte(`{"oauthAccount":{"id":"u1"},"mcpServers":{"clx":{"url":"u"}}}` + "\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatal(err)
	}

	ensureOnboardingState(slog.Default())

	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if !bytesEqual(readFile(t, path), original) {
		t.Fatal("unreadable user .claude.json MUST be left byte-identical")
	}
}

func TestEnsureOnboardingStateSkipsUnparseableFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".claude.json")
	original := []byte("{broken json\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}

	ensureOnboardingState(slog.Default())

	if !bytesEqual(readFile(t, path), original) {
		t.Fatal("unparseable user .claude.json MUST be left byte-identical")
	}
}

func TestEnsureOnboardingStateLeavesCompletedFileUntouched(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".claude.json")
	original := []byte(`{"hasCompletedOnboarding":true,"theme":"dark"}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}

	ensureOnboardingState(slog.Default())

	if !bytesEqual(readFile(t, path), original) {
		t.Fatal("already-onboarded file must not be rewritten")
	}
}

func TestEnsureOnboardingStatePreservesSiblingKeysAndMode(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".claude.json")
	if err := os.WriteFile(path, []byte(`{"hasCompletedOnboarding":false,"oauthAccount":{"id":"u1"},"theme":"dark"}`), 0o640); err != nil {
		t.Fatal(err)
	}

	ensureOnboardingState(slog.Default())

	m := parseObj(t, readFile(t, path))
	if m["hasCompletedOnboarding"] != true {
		t.Error("flag must be flipped to true")
	}
	if m["theme"] != "dark" {
		t.Error("unrelated keys must survive")
	}
	if _, ok := m["oauthAccount"]; !ok {
		t.Error("oauth state must survive")
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o640 {
		t.Errorf("existing file mode must be preserved, got %v", fi.Mode().Perm())
	}
}

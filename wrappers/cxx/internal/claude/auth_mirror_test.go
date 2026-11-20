package claude

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The ~/.clx/auth/credentials.json mirror has had no reader since 0.7.0, so a
// credential commit removes a stale copy (and its refresh token) instead of
// refreshing it. The wrapper state beside it stays.
func TestCommitRemovesStaleClxCredentialsMirror(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	mirror := filepath.Join(home, ".clx", "auth", "credentials.json")
	if err := os.MkdirAll(filepath.Dir(mirror), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mirror, []byte(`{"claudeAiOauth":{"accessToken":"stale","refreshToken":"stale-refresh"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	payload := json.RawMessage(`{"last_refresh":"2026-11-20T10:00:00Z","claudeAiOauth":{"accessToken":"fresh","refreshToken":"fresh-refresh"}}`)
	if _, err := writeAuth(payload, "", nil, false, false); err != nil {
		t.Fatalf("writeAuth: %v", err)
	}
	if _, err := os.Lstat(mirror); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale credentials mirror survived the commit: %v", err)
	}
	native, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil || !strings.Contains(string(native), "fresh-refresh") {
		t.Fatalf("native credentials = %q err=%v", native, err)
	}
	if _, err := os.Stat(filepath.Join(home, ".clx", "auth", generationStateFile)); err != nil {
		t.Fatalf("generation state beside the mirror was not kept: %v", err)
	}
}

// A mirror that is a symlink is unlinked; its target (here the native
// credentials file itself) is never removed.
func TestCommitUnlinksSymlinkedClxMirrorWithoutTouchingTarget(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	native := filepath.Join(home, ".claude", ".credentials.json")
	first := json.RawMessage(`{"last_refresh":"2026-11-20T10:00:00Z","claudeAiOauth":{"accessToken":"first","refreshToken":"first-refresh"}}`)
	if _, err := writeAuth(first, "", nil, false, false); err != nil {
		t.Fatalf("seed native credentials: %v", err)
	}
	mirror := filepath.Join(home, ".clx", "auth", "credentials.json")
	if err := os.MkdirAll(filepath.Dir(mirror), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(native, mirror); err != nil {
		t.Fatal(err)
	}
	second := json.RawMessage(`{"last_refresh":"2026-11-20T11:00:00Z","claudeAiOauth":{"accessToken":"second","refreshToken":"second-refresh"}}`)
	if _, err := writeAuth(second, "", nil, false, false); err != nil {
		t.Fatalf("writeAuth: %v", err)
	}
	if _, err := os.Lstat(mirror); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("symlinked mirror survived the commit: %v", err)
	}
	raw, err := os.ReadFile(native)
	if err != nil || !strings.Contains(string(raw), "second-refresh") {
		t.Fatalf("native credentials = %q err=%v", raw, err)
	}
}

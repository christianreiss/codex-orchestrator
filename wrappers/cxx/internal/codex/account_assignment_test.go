package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAccountAssignmentProtectsActiveChildAndNativeLogin(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	original := []byte(`{"last_refresh":"2026-09-30T10:00:00Z","tokens":{"access_token":"first-account"}}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	expected, err := CurrentAuthGeneration()
	if err != nil {
		t.Fatal(err)
	}
	child, err := AcquireActiveChild()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Release() })
	selected := json.RawMessage(`{"last_refresh":"2026-09-29T10:00:00Z","tokens":{"access_token":"second-account"}}`)
	got, err := WriteAssignedAccountIfCurrent(selected, expected, true)
	if err != nil || got.Written || !got.BlockedByActiveChild {
		t.Fatalf("active account switch: %+v, %v", got, err)
	}
	current, _ := CurrentAuthGeneration()
	if current != expected {
		t.Fatal("account switch changed active credentials")
	}
	if err := child.Release(); err != nil {
		t.Fatal(err)
	}
	got, err = WriteAssignedAccountIfCurrent(selected, expected, true)
	if err != nil || !got.Written {
		t.Fatalf("idle account switch: %+v, %v", got, err)
	}
	expected, _ = CurrentAuthGeneration()
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err = WriteAssignedAccountIfCurrent(selected, expected, true)
	if err != nil || got.Written {
		t.Fatalf("racing native login: %+v, %v", got, err)
	}
	current, _ = CurrentAuthGeneration()
	if current == expected {
		t.Fatal("native login was overwritten")
	}
}

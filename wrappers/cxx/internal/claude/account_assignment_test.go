package claude

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func TestAccountAssignmentProtectsActiveChildAndNativeLogin(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	original := json.RawMessage(`{"last_refresh":"2026-09-30T10:00:00Z","claudeAiOauth":{"accessToken":"first-account","refreshToken":"first-refresh","expiresAt":4102444800000}}`)
	if err := WriteAuth(original); err != nil {
		t.Fatal(err)
	}
	before, err := ReadAuthForRetrieveSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	child, err := acquireAuthChildShared()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Close() })
	selected := json.RawMessage(`{"last_refresh":"2026-09-29T10:00:00Z","claudeAiOauth":{"accessToken":"second-account","refreshToken":"second-refresh","expiresAt":4102444800000}}`)
	wrote, err := WriteAssignedAccountIfCurrent(selected, "", before.Generation, true)
	if !errors.Is(err, ErrAuthChildActive) || wrote {
		t.Fatalf("active account switch: %v, %v", wrote, err)
	}
	current, err := ReadAuthForRetrieveSnapshot()
	if err != nil || current.Generation != before.Generation {
		t.Fatalf("active credentials changed: %+v, %v", current.Generation, err)
	}
	if err := child.Close(); err != nil {
		t.Fatal(err)
	}
	wrote, err = WriteAssignedAccountIfCurrent(selected, "", before.Generation, true)
	if err != nil || !wrote {
		t.Fatalf("idle account switch: %v, %v", wrote, err)
	}
	before, err = ReadAuthForRetrieveSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	path, err := AuthPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	wrote, err = WriteAssignedAccountIfCurrent(selected, "", before.Generation, true)
	if err != nil || wrote {
		t.Fatalf("racing native login: %v, %v", wrote, err)
	}
	current, err = ReadAuthForRetrieveSnapshot()
	if err != nil || current.Generation == before.Generation {
		t.Fatalf("native login overwritten: %+v, %v", current.Generation, err)
	}
}

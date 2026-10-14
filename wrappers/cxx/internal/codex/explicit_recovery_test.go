package codex

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestExplicitRecoveryCannotOverwriteAnActiveChild(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	path, _ := AuthPath()
	local := []byte(`{"last_refresh":"2026-10-13T09:00:00Z","tokens":{"access_token":"local","refresh_token":"fixture"}}`)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, local, 0600); err != nil {
		t.Fatal(err)
	}
	expected, err := CurrentAuthGeneration()
	if err != nil {
		t.Fatal(err)
	}
	lease, err := AcquireActiveChild()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	out, err := AdoptAuthForExplicitRecovery(context.Background(), json.RawMessage(`{"last_refresh":"2026-10-13T08:00:00Z","tokens":{"access_token":"server","refresh_token":"fixture"}}`), "verified", expected)
	if err != nil || out.Written || !out.BlockedByActiveChild {
		t.Fatalf("idle guard failed: %+v %v", out, err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != string(local) {
		t.Fatal("active native auth overwritten")
	}
}

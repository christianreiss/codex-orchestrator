package claude

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestExplicitRecoveryCannotOverwriteAnActiveChild(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	local := json.RawMessage(`{"last_refresh":"2026-10-13T09:00:00Z","claudeAiOauth":{"accessToken":"local","refreshToken":"fixture"}}`)
	if err := WriteAuth(local); err != nil {
		t.Fatal(err)
	}
	before, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := acquireAuthChildShared()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	_, wrote, err := AdoptAuthForExplicitRecovery(context.Background(), json.RawMessage(`{"last_refresh":"2026-10-13T08:00:00Z","claudeAiOauth":{"accessToken":"server","refreshToken":"fixture"}}`), strings.Repeat("b", 64), "verified", before.Generation)
	if err == nil || wrote {
		t.Fatalf("idle guard failed: wrote=%v err=%v", wrote, err)
	}
	raw, _ := os.ReadFile(before.Path)
	if string(raw) != string(before.Raw) {
		t.Fatal("active native auth overwritten")
	}
}

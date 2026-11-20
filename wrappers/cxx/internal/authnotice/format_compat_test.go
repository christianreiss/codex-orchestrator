package authnotice

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// legacyDir recomputes the mailbox directory exactly as released binaries did
// before the shared session mailbox, independent of the package under test.
func legacyDir(home, engine, scope string) string {
	digest := sha256.Sum256([]byte(filepath.Clean(scope)))
	return filepath.Join(home, ".cache", "codex-orchestrator", "auth-notices", engine+"-"+hex.EncodeToString(digest[:8]))
}

func TestNoticeWrittenByOlderBinaryIsConsumed(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	dir := legacyDir(home, "claude", filepath.Join(home, ".claude"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	gen := generation("legacy")
	// Byte-for-byte what an older binary's json.Marshal(Notice{...}) wrote.
	raw := `{"generation":"` + gen + `","engine":"claude","updated_at":"` + time.Now().UTC().Format(time.RFC3339Nano) + `"}`
	if err := os.WriteFile(filepath.Join(dir, "current.json"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	notice, err := consume("claude", "session")
	if err != nil || notice == nil || notice.Generation != gen || notice.Engine != "claude" {
		t.Fatalf("legacy notice not consumed: %+v %v", notice, err)
	}
	// Older consumers compare this plain ledger, so it must stay the bare generation.
	seen, err := os.ReadFile(filepath.Join(dir, "session.seen"))
	if err != nil || string(seen) != gen {
		t.Fatalf("ledger format changed: %q %v", seen, err)
	}
	if again, err := consume("claude", "session"); err != nil || again != nil {
		t.Fatalf("legacy notice replayed: %+v %v", again, err)
	}
}

func TestPublishedNoticeKeepsLegacyFileShape(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	codexHome := filepath.Join(home, "custom-codex")
	t.Setenv("CODEX_HOME", codexHome)
	gen := generation("current")
	if err := Publish("codex", gen); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(legacyDir(home, "codex", codexHome), "current.json"))
	if err != nil {
		t.Fatalf("notice not at the legacy path: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "engine,generation,updated_at" || fields["generation"] != gen || fields["engine"] != "codex" {
		t.Fatalf("notice JSON shape changed: %s", raw)
	}
	if _, err := time.Parse(time.RFC3339Nano, fields["updated_at"].(string)); err != nil {
		t.Fatalf("updated_at format changed: %s", raw)
	}
}

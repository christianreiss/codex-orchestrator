package contentnotice

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
	return filepath.Join(home, ".cache", "codex-orchestrator", "content-notices", engine+"-"+hex.EncodeToString(digest[:8]))
}

func TestNoticeWrittenByOlderBinaryIsConsumed(t *testing.T) {
	home := isolate(t)
	t.Setenv("KIMI_CODE_HOME", "")
	dir := legacyDir(home, "kimi", filepath.Join(home, ".kimi-code"))
	gen := strings.Repeat("c", 64)
	// Byte-for-byte what an older binary's json.Marshal(Notice{...}) wrote.
	raw := `{"generation":"` + gen + `","engine":"kimi","kinds":["config","skills"],"digests":{"config":"d1","instructions":"d0","skills":"d2"},"instructions":"/x/AGENTS.md","updated_at":"` + time.Now().UTC().Format(time.RFC3339Nano) + `"}`
	write(t, filepath.Join(dir, "current.json"), raw)
	// An older consumer acknowledged an earlier generation and wrote no companion metadata.
	write(t, filepath.Join(dir, "session.seen"), strings.Repeat("a", 64))
	notice, err := consume("kimi", "session")
	if err != nil || notice == nil || notice.Generation != gen || strings.Join(notice.Kinds, ",") != "config,skills" || notice.Instructions != "/x/AGENTS.md" || notice.Digests["skills"] != "d2" {
		t.Fatalf("legacy notice not consumed in full: %+v %v", notice, err)
	}
	seen, err := os.ReadFile(filepath.Join(dir, "session.seen"))
	if err != nil || string(seen) != gen {
		t.Fatalf("plain ledger format changed: %q %v", seen, err)
	}
	companion, err := os.ReadFile(filepath.Join(dir, "session.seen.json"))
	if err != nil {
		t.Fatal(err)
	}
	var meta map[string]any
	if err := json.Unmarshal(companion, &meta); err != nil || meta["generation"] != gen || len(meta) != 2 {
		t.Fatalf("companion ledger shape changed: %s %v", companion, err)
	}
	if again, err := consume("kimi", "session"); err != nil || again != nil {
		t.Fatalf("legacy notice replayed: %+v %v", again, err)
	}
}

func TestPublishedNoticeKeepsLegacyFileShape(t *testing.T) {
	home := isolate(t)
	grokHome := filepath.Join(home, "custom-grok")
	t.Setenv("GROK_HOME", grokHome)
	notice := Notice{Generation: strings.Repeat("d", 64), Engine: "grok", Kinds: []string{KindSkills}, Digests: Snapshot{KindSkills: "s"}, Instructions: "/g/AGENTS.md"}
	if err := Publish(notice); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(legacyDir(home, "grok", grokHome), "current.json"))
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
	if strings.Join(keys, ",") != "digests,engine,generation,instructions,kinds,updated_at" || fields["generation"] != notice.Generation {
		t.Fatalf("notice JSON shape changed: %s", raw)
	}
	if !strings.HasPrefix(string(raw), `{"generation":"`+notice.Generation+`","engine":"grok","kinds":["skills"],"digests":{"skills":"s"},"instructions":"/g/AGENTS.md","updated_at":"`) {
		t.Fatalf("notice JSON encoding changed: %s", raw)
	}
}

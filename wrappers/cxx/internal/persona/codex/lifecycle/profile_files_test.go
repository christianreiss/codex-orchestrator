package lifecycle

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func profile(name, content string) orchestrator.ConfigProfile {
	sum := sha256.Sum256([]byte(content))
	return orchestrator.ConfigProfile{Name: name, SHA256: hex.EncodeToString(sum[:]), Content: content}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestSyncProfileFilesWritesAndIsIdempotent(t *testing.T) {
	home := t.TempDir()
	fast := profile("fast", "model = \"gpt-6-luna\"\n")
	changed, err := syncProfileFiles(home, []orchestrator.ConfigProfile{fast})
	if err != nil || !changed {
		t.Fatalf("first sync changed=%v err=%v", changed, err)
	}
	if got := readFile(t, filepath.Join(home, "fast.config.toml")); got != fast.Content {
		t.Fatalf("profile body = %q", got)
	}
	changed, err = syncProfileFiles(home, []orchestrator.ConfigProfile{fast})
	if err != nil || changed {
		t.Fatalf("second sync changed=%v err=%v, want a no-op", changed, err)
	}
	fast2 := profile("fast", "model = \"gpt-6-astra\"\n")
	if changed, _ = syncProfileFiles(home, []orchestrator.ConfigProfile{fast2}); !changed {
		t.Fatal("a changed profile was not rewritten")
	}
}

// Only a file the fleet wrote is ever removed.
func TestSyncProfileFilesPrunesOnlyManagedFiles(t *testing.T) {
	home := t.TempDir()
	user := filepath.Join(home, "mine.config.toml")
	if err := os.WriteFile(user, []byte("model = \"x\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := syncProfileFiles(home, []orchestrator.ConfigProfile{profile("fast", "a = 1\n"), profile("slow", "b = 2\n")}); err != nil {
		t.Fatal(err)
	}
	changed, err := syncProfileFiles(home, []orchestrator.ConfigProfile{profile("fast", "a = 1\n")})
	if err != nil || !changed {
		t.Fatalf("prune changed=%v err=%v", changed, err)
	}
	if _, err := os.Stat(filepath.Join(home, "slow.config.toml")); !os.IsNotExist(err) {
		t.Fatalf("dropped fleet profile survived: %v", err)
	}
	if _, err := os.Stat(user); err != nil {
		t.Fatalf("user-authored profile was removed: %v", err)
	}
	// An empty (present) list prunes everything the fleet owns, and nothing else.
	if _, err := syncProfileFiles(home, []orchestrator.ConfigProfile{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "fast.config.toml")); !os.IsNotExist(err) {
		t.Fatalf("fleet profile survived an empty list: %v", err)
	}
	if _, err := os.Stat(user); err != nil {
		t.Fatalf("user-authored profile was removed by an empty list: %v", err)
	}
}

func TestSyncProfileFilesNeverClobbersUserFile(t *testing.T) {
	home := t.TempDir()
	dst := filepath.Join(home, "fast.config.toml")
	if err := os.WriteFile(dst, []byte("mine = true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	changed, err := syncProfileFiles(home, []orchestrator.ConfigProfile{profile("fast", "a = 1\n")})
	if err == nil || changed {
		t.Fatalf("changed=%v err=%v, want a refusal", changed, err)
	}
	if got := readFile(t, dst); got != "mine = true\n" {
		t.Fatalf("user file overwritten: %q", got)
	}
	// ...and it is not adopted, so a later empty list still leaves it alone.
	if _, err := syncProfileFiles(home, []orchestrator.ConfigProfile{}); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dst); got != "mine = true\n" {
		t.Fatalf("user file removed: %q", got)
	}
}

func TestSyncProfileFilesRejectsUnsafeNames(t *testing.T) {
	home := t.TempDir()
	changed, err := syncProfileFiles(home, []orchestrator.ConfigProfile{profile("../evil", "a = 1\n"), profile("has space", "a = 1\n"), profile("", "a = 1\n")})
	if err == nil || changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	entries, _ := os.ReadDir(home)
	if len(entries) != 0 {
		t.Fatalf("unsafe names wrote files: %v", entries)
	}
}

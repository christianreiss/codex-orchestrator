package lifecycle

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
)

func TestFingerprintSkillsOrderIndependent(t *testing.T) {
	a := []orchestrator.Skill{
		{Slug: "a", SHA256: "1"},
		{Slug: "b", SHA256: "2"},
	}
	b := []orchestrator.Skill{
		{Slug: "b", SHA256: "2"},
		{Slug: "a", SHA256: "1"},
	}
	if fingerprintSkills(a) != fingerprintSkills(b) {
		t.Fatal("fingerprint must be order-independent")
	}
}

func TestFingerprintSkillsChangesWhenShaChanges(t *testing.T) {
	a := []orchestrator.Skill{{Slug: "a", SHA256: "1"}}
	b := []orchestrator.Skill{{Slug: "a", SHA256: "2"}}
	if fingerprintSkills(a) == fingerprintSkills(b) {
		t.Fatal("sha change must alter fingerprint")
	}
}

func TestPruneLegacySkillDirsOneShot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dirs := []string{
		filepath.Join(home, ".agents", "skills"),
		filepath.Join(home, ".codex", "skills"),
		filepath.Join(home, ".codex", "prompts"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
		if err := os.WriteFile(filepath.Join(d, "stale"), []byte("x"), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	logger := slog.Default()
	pruneLegacySkillDirs("1.2.3", logger)
	for _, d := range dirs {
		if _, err := os.Stat(d); !os.IsNotExist(err) {
			t.Fatalf("expected %s pruned, stat err=%v", d, err)
		}
	}
	// Second call must be a no-op (sentinel present); recreate a dir and
	// verify it's left alone.
	if err := os.MkdirAll(dirs[0], 0o755); err != nil {
		t.Fatalf("recreate: %v", err)
	}
	pruneLegacySkillDirs("1.2.3", logger)
	if _, err := os.Stat(dirs[0]); err != nil {
		t.Fatalf("sentinel-guarded run unexpectedly pruned: %v", err)
	}
	// Bumping the wrapper version must invalidate the sentinel.
	pruneLegacySkillDirs("1.2.4", logger)
	if _, err := os.Stat(dirs[0]); !os.IsNotExist(err) {
		t.Fatalf("version bump should retrigger prune; stat err=%v", err)
	}
}

func TestSkillsDigestRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if got := readSkillsDigest(); got != "" {
		t.Fatalf("fresh HOME should yield empty digest, got %q", got)
	}
	writeSkillsDigest("abc123")
	if got := readSkillsDigest(); got != "abc123" {
		t.Fatalf("digest round-trip failed: got %q", got)
	}
}

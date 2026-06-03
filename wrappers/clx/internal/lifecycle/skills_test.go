package lifecycle

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
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
	// Legacy bash-era caches that MUST be pruned.
	dirs := []string{
		filepath.Join(home, ".agents", "skills"),
		filepath.Join(home, ".clx", "skills"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}
	// ~/.claude/skills is now the fleet-managed on-disk skill store and MUST survive.
	keep := filepath.Join(home, ".claude", "skills", "git-commit", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(keep), 0o755); err != nil {
		t.Fatalf("mkdir claude skills: %v", err)
	}
	if err := os.WriteFile(keep, []byte("---\nname: git-commit\n---\n"), 0o644); err != nil {
		t.Fatalf("write skill: %v", err)
	}
	logger := slog.Default()
	pruneLegacySkillDirs("1.2.3", logger)
	for _, d := range dirs {
		if _, err := os.Stat(d); !os.IsNotExist(err) {
			t.Fatalf("expected %s pruned, stat err=%v", d, err)
		}
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("~/.claude/skills must NOT be pruned (fleet-managed): %v", err)
	}
	// Second call is a no-op while sentinel exists.
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

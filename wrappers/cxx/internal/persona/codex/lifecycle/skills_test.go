package lifecycle

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func TestSyncSkillsReportsListFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"unavailable"}`, http.StatusBadRequest)
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	got := syncSkills(context.Background(), client, logger)
	if !got.Checked || got.Err == nil || got.Updated {
		t.Fatalf("syncSkills failure = %+v, want checked warning", got)
	}
}

func TestSyncSkillsReportsSuccessfulUnchanged(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"skills":[{"slug":"git","sha256":"abc"}]}`)
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	if first := syncSkills(context.Background(), client, logger); first.Err != nil || !first.Updated {
		t.Fatalf("first sync = %+v, want updated success", first)
	}
	if second := syncSkills(context.Background(), client, logger); second.Err != nil || !second.Checked || second.Updated {
		t.Fatalf("second sync = %+v, want unchanged success", second)
	}
}

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

func TestPruneLegacySkillDirsRetriesAfterFailure(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	target := filepath.Join(home, ".codex", "skills")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	failed := pruneLegacySkillDirsWith("9.9.9", logger, func(string) error { return errors.New("busy") })
	if failed.Err == nil || failed.Updated {
		t.Fatalf("failed prune = %+v, want visible retryable error", failed)
	}
	if _, err := os.Stat(legacyCleanupSentinel("9.9.9")); !os.IsNotExist(err) {
		t.Fatalf("failed prune wrote sentinel: %v", err)
	}
	retried := pruneLegacySkillDirs("9.9.9", logger)
	if retried.Err != nil || !retried.Updated {
		t.Fatalf("retry prune = %+v", retried)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("retry did not remove target: %v", err)
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

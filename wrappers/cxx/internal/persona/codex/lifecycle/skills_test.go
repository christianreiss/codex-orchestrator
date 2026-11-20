package lifecycle

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
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

// User-authored native skills and prompts must survive every sync and every
// wrapper release. Until 2026-11 a per-version "legacy cleanup" deleted these
// directories on the first sync after each wrapper update.
func TestSyncSkillsKeepsUserSkillAndPromptDirs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	dirs := []string{
		filepath.Join(home, ".agents", "skills", "mine"),
		filepath.Join(home, ".codex", "skills", "mine"),
		filepath.Join(home, ".codex", "prompts"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "SKILL.md"), []byte("user content"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"skills":[{"slug":"git","sha256":"abc"}]}`)
	}))
	defer server.Close()
	cfg := &config.Config{Engine: "codex", Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
	// The communicator "skills" operation is where the old prune ran unconditionally.
	if got := CommunicatorWork(context.Background(), cfg, communicator.SyncRequest{Operation: "skills"}); got.Error != nil {
		t.Fatalf("skills operation = %+v", got.Error)
	}
	for _, d := range dirs {
		if _, err := os.Stat(filepath.Join(d, "SKILL.md")); err != nil {
			t.Fatalf("user content in %s was removed: %v", d, err)
		}
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

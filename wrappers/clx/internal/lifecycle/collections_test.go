package lifecycle

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
)

func item(slug, sha, content string) orchestrator.CollectionItem {
	return orchestrator.CollectionItem{Slug: slug, SHA256: sha, Status: "updated", Content: content}
}

func TestApplyCollectionWritesFilesAndManifest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()

	updated := applyCollection("subagent", []orchestrator.CollectionItem{
		item("reviewer", "sha-r", "---\nname: reviewer\n---\n\nbody\n"),
	}, logger)
	if !updated {
		t.Fatal("expected updated=true on first write")
	}
	path := filepath.Join(home, ".claude", "agents", "reviewer.md")
	if !fileExists(path) {
		t.Fatalf("expected %s written", path)
	}
	man := loadManifest(collectionManifestPath("agents"))
	if man.Items["reviewer"].SHA256 != "sha-r" {
		t.Fatalf("manifest missing reviewer: %+v", man.Items)
	}
}

func TestApplyCollectionIfNoneMatchSkipsRewrite(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()

	applyCollection("subagent", []orchestrator.CollectionItem{item("a", "sha-a", "v1")}, logger)
	// Second pass: same sha, server omits content (status unchanged). File must stay.
	updated := applyCollection("subagent", []orchestrator.CollectionItem{
		{Slug: "a", SHA256: "sha-a", Status: "unchanged"},
	}, logger)
	if updated {
		t.Fatal("unchanged item must not report an update")
	}
	got, _ := os.ReadFile(filepath.Join(home, ".claude", "agents", "a.md"))
	if string(got) != "v1" {
		t.Fatalf("file should be untouched, got %q", got)
	}
}

func TestApplyCollectionPrunesOnlyFleetFiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	dir := filepath.Join(home, ".claude", "agents")

	// A user-authored file the fleet never wrote.
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	userFile := filepath.Join(dir, "my-own.md")
	if err := os.WriteFile(userFile, []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}

	applyCollection("subagent", []orchestrator.CollectionItem{
		item("a", "1", "A"), item("b", "2", "B"),
	}, logger)
	// Now 'b' disappears from the live set.
	applyCollection("subagent", []orchestrator.CollectionItem{item("a", "1", "A")}, logger)

	if fileExists(filepath.Join(dir, "b.md")) {
		t.Fatal("b.md (fleet-written, removed) should be pruned")
	}
	if !fileExists(filepath.Join(dir, "a.md")) {
		t.Fatal("a.md should survive")
	}
	if !fileExists(userFile) {
		t.Fatal("user-authored my-own.md must NEVER be pruned")
	}
}

func TestSanitizeSlugRejectsTraversal(t *testing.T) {
	for _, bad := range []string{"", "../etc", "a/b", "a\\b", "..", "with space", "weird$"} {
		if got := sanitizeSlug(bad); got != "" {
			t.Fatalf("sanitizeSlug(%q) should be rejected, got %q", bad, got)
		}
	}
	for _, good := range []string{"reviewer", "code-reviewer", "a.b_c-1"} {
		if got := sanitizeSlug(good); got != good {
			t.Fatalf("sanitizeSlug(%q) should pass, got %q", good, got)
		}
	}
}

func TestApplyCollectionRejectsUnsafeSlug(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	applyCollection("subagent", []orchestrator.CollectionItem{item("../escape", "x", "pwn")}, slog.Default())
	if fileExists(filepath.Join(home, ".claude", "escape.md")) {
		t.Fatal("path traversal must not write outside the collection dir")
	}
}

func TestArtifactDigestsForRequestRoundTrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if len(artifactDigestsForRequest()) != 0 {
		t.Fatal("fresh HOME should advertise no artifacts")
	}
	applyCollection("subagent", []orchestrator.CollectionItem{item("a", "sha-a", "A")}, slog.Default())
	applyCollection("command", []orchestrator.CollectionItem{item("c", "sha-c", "C")}, slog.Default())
	d := artifactDigestsForRequest()
	if d["subagent"]["a"] != "sha-a" || d["command"]["c"] != "sha-c" {
		t.Fatalf("digests round-trip failed: %+v", d)
	}
}

func TestStripClaudeCollectionsRemovesFleetFilesOnly(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	dir := filepath.Join(home, ".claude", "agents")
	applyCollection("subagent", []orchestrator.CollectionItem{item("a", "1", "A")}, logger)
	if err := os.WriteFile(filepath.Join(dir, "user.md"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	stripClaudeCollections(logger)
	if fileExists(filepath.Join(dir, "a.md")) {
		t.Fatal("fleet file should be stripped")
	}
	if !fileExists(filepath.Join(dir, "user.md")) {
		t.Fatal("user file must survive strip")
	}
	if len(artifactDigestsForRequest()) != 0 {
		t.Fatal("manifest should be cleared after strip")
	}
}

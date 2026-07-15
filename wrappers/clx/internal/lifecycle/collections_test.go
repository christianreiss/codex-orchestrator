package lifecycle

import (
	"errors"
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

func TestApplyClaudeArtifactsResultReportsIncompleteWrite(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	updated, err := applyClaudeArtifactsResult(&orchestrator.ClaudeArtifacts{
		Subagents: []orchestrator.CollectionItem{{Slug: "reviewer", SHA256: "new", Status: "updated"}},
	}, slog.Default())
	if updated || err == nil {
		t.Fatalf("incomplete artifact sync = updated %t, err %v", updated, err)
	}
}

func TestApplyClaudeArtifactsResultPreservesLastGoodItem(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	applyCollection("subagent", []orchestrator.CollectionItem{item("reviewer", "old", "old body")}, logger)

	updated, err := applyClaudeArtifactsResult(&orchestrator.ClaudeArtifacts{
		Subagents: []orchestrator.CollectionItem{{Slug: "reviewer", SHA256: "new", Status: "updated"}},
	}, logger)
	if updated || err == nil {
		t.Fatalf("incomplete artifact update = updated %t, err %v", updated, err)
	}
	body, readErr := os.ReadFile(filepath.Join(home, ".claude", "agents", "reviewer.md"))
	if readErr != nil || string(body) != "old body" {
		t.Fatalf("last good artifact was not preserved: body %q, err %v", body, readErr)
	}
	if got := loadManifest(collectionManifestPath("agents")).Items["reviewer"].SHA256; got != "old" {
		t.Fatalf("last good artifact manifest SHA = %q", got)
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

func TestStripClaudeCollectionsRetainsOwnershipAfterRemoveFailure(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	path := filepath.Join(home, ".claude", "agents", "a.md")
	applyCollection("subagent", []orchestrator.CollectionItem{item("a", "1", "A")}, logger)
	err := stripClaudeCollectionsWith(logger, func(string) error { return errors.New("busy") })
	if err == nil || !fileExists(path) || artifactDigestsForRequest()["subagent"]["a"] != "1" {
		t.Fatalf("failed strip lost file ownership: err=%v digests=%v", err, artifactDigestsForRequest())
	}
	if err := stripClaudeCollections(logger); err != nil {
		t.Fatalf("retry strip: %v", err)
	}
	if fileExists(path) || len(artifactDigestsForRequest()) != 0 {
		t.Fatalf("retry did not clear file and ownership: digests=%v", artifactDigestsForRequest())
	}
}

func skillItem(slug, sha, content string) orchestrator.CollectionItem {
	return orchestrator.CollectionItem{Slug: slug, SHA256: sha, Status: "updated", Content: content}
}

func TestApplyClaudeSkillsWritesDirAndManifest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	updated := applyClaudeSkills([]orchestrator.CollectionItem{
		skillItem("git-commit", "sha-g", "---\nname: git-commit\ndescription: x\n---\n\nbody\n"),
	}, logger)
	if !updated {
		t.Fatal("expected updated=true")
	}
	path := filepath.Join(home, ".claude", "skills", "git-commit", "SKILL.md")
	if !fileExists(path) {
		t.Fatalf("expected %s written", path)
	}
	man := loadManifest(collectionManifestPath("skills"))
	if man.Items["git-commit"].Filename != filepath.Join("git-commit", "SKILL.md") {
		t.Fatalf("manifest filename wrong: %+v", man.Items)
	}
}

func TestApplyClaudeSkillsIfNoneMatch(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	applyClaudeSkills([]orchestrator.CollectionItem{skillItem("a", "sha-a", "v1")}, logger)
	updated := applyClaudeSkills([]orchestrator.CollectionItem{
		{Slug: "a", SHA256: "sha-a", Status: "unchanged"},
	}, logger)
	if updated {
		t.Fatal("unchanged skill must not report an update")
	}
	got, _ := os.ReadFile(filepath.Join(home, ".claude", "skills", "a", "SKILL.md"))
	if string(got) != "v1" {
		t.Fatalf("file should be untouched, got %q", got)
	}
}

func TestApplyClaudeSkillsResultReportsIncompleteWrite(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	updated, err := applyClaudeSkillsResult([]orchestrator.CollectionItem{{
		Slug: "reviewer", SHA256: "new", Status: "updated",
	}}, slog.Default())
	if updated || err == nil {
		t.Fatalf("incomplete skill sync = updated %t, err %v", updated, err)
	}
}

func TestApplyClaudeSkillsResultPreservesLastGoodItem(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	applyClaudeSkills([]orchestrator.CollectionItem{skillItem("reviewer", "old", "old body")}, logger)

	updated, err := applyClaudeSkillsResult([]orchestrator.CollectionItem{{
		Slug: "reviewer", SHA256: "new", Status: "updated",
	}}, logger)
	if updated || err == nil {
		t.Fatalf("incomplete skill update = updated %t, err %v", updated, err)
	}
	body, readErr := os.ReadFile(filepath.Join(home, ".claude", "skills", "reviewer", "SKILL.md"))
	if readErr != nil || string(body) != "old body" {
		t.Fatalf("last good skill was not preserved: body %q, err %v", body, readErr)
	}
	if got := loadManifest(collectionManifestPath("skills")).Items["reviewer"].SHA256; got != "old" {
		t.Fatalf("last good skill manifest SHA = %q", got)
	}
}

func TestApplyClaudeSkillsNilLegacyPayloadDoesNotPrune(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	applyClaudeSkills([]orchestrator.CollectionItem{skillItem("reviewer", "sha", "body")}, logger)

	updated, err := applyClaudeSkillsResult(nil, logger)
	if updated || err != nil {
		t.Fatalf("legacy nil skill payload = updated %t, err %v", updated, err)
	}
	if !fileExists(filepath.Join(home, ".claude", "skills", "reviewer", "SKILL.md")) {
		t.Fatal("legacy server omission pruned an existing managed skill")
	}
}

func TestApplyClaudeSkillsPrunesOnlyFleetDirs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	root := filepath.Join(home, ".claude", "skills")
	// User-authored skill dir — must survive sync + prune.
	userDir := filepath.Join(root, "mine")
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userDir, "SKILL.md"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	applyClaudeSkills([]orchestrator.CollectionItem{skillItem("a", "1", "A"), skillItem("b", "1", "B")}, logger)
	// Re-apply without "b" → b/ pruned, a/ + mine/ survive.
	applyClaudeSkills([]orchestrator.CollectionItem{skillItem("a", "1", "A")}, logger)
	if fileExists(filepath.Join(root, "b", "SKILL.md")) {
		t.Fatal("dropped skill dir b/ must be pruned")
	}
	if !fileExists(filepath.Join(root, "a", "SKILL.md")) {
		t.Fatal("kept skill a/ must survive")
	}
	if !fileExists(filepath.Join(userDir, "SKILL.md")) {
		t.Fatal("user-authored skill dir must never be pruned")
	}
}

func TestApplyClaudeSkillsRejectsUnsafeSlug(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	applyClaudeSkills([]orchestrator.CollectionItem{skillItem("../escape", "1", "pwn")}, logger)
	if fileExists(filepath.Join(home, ".claude", "escape", "SKILL.md")) {
		t.Fatal("traversal slug must not write outside skills/")
	}
	if len(skillDigestsForRequest()) != 0 {
		t.Fatal("unsafe slug must not be recorded")
	}
}

func TestSkillDigestsForRequestRoundTrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	applyClaudeSkills([]orchestrator.CollectionItem{skillItem("a", "sha-a", "A")}, logger)
	d := skillDigestsForRequest()
	if d["a"] != "sha-a" {
		t.Fatalf("digest round-trip failed: %+v", d)
	}
}

func TestStripClaudeSkillsRemovesFleetDirsOnly(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	root := filepath.Join(home, ".claude", "skills")
	applyClaudeSkills([]orchestrator.CollectionItem{skillItem("a", "1", "A")}, logger)
	userDir := filepath.Join(root, "mine")
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userDir, "SKILL.md"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	stripClaudeSkills(logger)
	if fileExists(filepath.Join(root, "a", "SKILL.md")) {
		t.Fatal("fleet skill dir should be stripped")
	}
	if !fileExists(filepath.Join(userDir, "SKILL.md")) {
		t.Fatal("user skill dir must survive strip")
	}
	if len(skillDigestsForRequest()) != 0 {
		t.Fatal("manifest should be cleared after strip")
	}
}

func TestStripClaudeSkillsRetainsOwnershipAfterRemoveFailure(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	path := filepath.Join(home, ".claude", "skills", "a", "SKILL.md")
	applyClaudeSkills([]orchestrator.CollectionItem{skillItem("a", "1", "A")}, logger)
	err := stripClaudeSkillsWith(logger, func(string) error { return errors.New("busy") })
	if err == nil || !fileExists(path) || skillDigestsForRequest()["a"] != "1" {
		t.Fatalf("failed skill strip lost ownership: err=%v digests=%v", err, skillDigestsForRequest())
	}
	if err := stripClaudeSkills(logger); err != nil {
		t.Fatalf("retry skill strip: %v", err)
	}
	if fileExists(path) || len(skillDigestsForRequest()) != 0 {
		t.Fatalf("retry did not clear skill and ownership: digests=%v", skillDigestsForRequest())
	}
}

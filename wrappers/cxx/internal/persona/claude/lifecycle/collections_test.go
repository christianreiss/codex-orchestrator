package lifecycle

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
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
	updated, err := applyClaudeArtifactsResult(context.Background(), &orchestrator.ClaudeArtifacts{
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

	updated, err := applyClaudeArtifactsResult(context.Background(), &orchestrator.ClaudeArtifacts{
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

func skillItem(slug, _ string, content string) orchestrator.CollectionItem {
	return orchestrator.CollectionItem{
		Slug: slug, SHA256: collectionFileDigest(content), Status: "updated", Content: content,
	}
}

func skillFile(path, content string) orchestrator.CollectionFile {
	return orchestrator.CollectionFile{
		Path:    path,
		SHA256:  fmt.Sprintf("%x", sha256.Sum256([]byte(content))),
		Content: content,
	}
}

func setSkillFiles(item *orchestrator.CollectionItem, files ...orchestrator.CollectionFile) {
	item.Files = files
	item.ManifestSHA256 = collectionFileDigest(item.Content)
	fileDigests := make(map[string]string, len(files))
	for _, file := range files {
		fileDigests[file.Path] = file.SHA256
	}
	item.SHA256 = canonicalSkillBundleDigest(item.ManifestSHA256, fileDigests)
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
	rec := man.Items["git-commit"]
	if rec.Filename != filepath.Join("git-commit", "SKILL.md") {
		t.Fatalf("manifest filename wrong: %+v", man.Items)
	}
	if rec.ManifestSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte("---\nname: git-commit\ndescription: x\n---\n\nbody\n"))) {
		t.Fatalf("manifest content digest missing: %+v", rec)
	}
}

func TestApplyClaudeSkillsWritesCompleteBundle(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	item := skillItem("tdd", "bundle-sha", "---\nname: tdd\ndescription: x\n---\n")
	setSkillFiles(&item,
		skillFile("tests.md", "test guidance\n"),
		skillFile("agents/openai.yaml", "policy:\n  allow_implicit_invocation: false\n"),
	)
	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{item}, slog.Default())
	if !updated || err != nil {
		t.Fatalf("bundle apply = updated %t, err %v", updated, err)
	}
	root := filepath.Join(home, ".claude", "skills", "tdd")
	for _, rel := range []string{"SKILL.md", "tests.md", filepath.Join("agents", "openai.yaml")} {
		if !fileExists(filepath.Join(root, rel)) {
			t.Fatalf("missing bundled file %s", rel)
		}
	}
	rec := loadManifest(collectionManifestPath("skills")).Items["tdd"]
	if rec.SHA256 != item.SHA256 || len(rec.Files) != 2 || len(rec.FileSHA256) != 2 {
		t.Fatalf("bundle ownership not recorded: %+v", rec)
	}
	if rec.ManifestSHA256 != item.ManifestSHA256 || rec.FileSHA256["tests.md"] != item.Files[0].SHA256 {
		t.Fatalf("bundle integrity metadata not recorded: %+v", rec)
	}
}

func TestApplyClaudeSkillsBundleUpdatePrunesRemovedAuxiliaryFiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	first := skillItem("tdd", "one", "v1")
	setSkillFiles(&first,
		skillFile("keep.md", "keep-v1"),
		skillFile("drop.md", "drop"),
	)
	applyClaudeSkills([]orchestrator.CollectionItem{first}, slog.Default())
	second := skillItem("tdd", "two", "v2")
	setSkillFiles(&second, skillFile("keep.md", "keep-v2"))
	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{second}, slog.Default())
	if !updated || err != nil {
		t.Fatalf("bundle update = updated %t, err %v", updated, err)
	}
	root := filepath.Join(home, ".claude", "skills", "tdd")
	if fileExists(filepath.Join(root, "drop.md")) {
		t.Fatal("removed upstream file survived directory swap")
	}
	body, _ := os.ReadFile(filepath.Join(root, "keep.md"))
	if string(body) != "keep-v2" {
		t.Fatalf("kept file was not updated: %q", body)
	}
}

func TestApplyClaudeSkillsRejectsUnsafeBundlePathAndPreservesLastGood(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	old := skillItem("tdd", "old", "old body")
	setSkillFiles(&old, skillFile("tests.md", "old ref"))
	applyClaudeSkills([]orchestrator.CollectionItem{old}, logger)
	next := skillItem("tdd", "new", "new body")
	setSkillFiles(&next, skillFile("../escape", "pwn"))
	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{next}, logger)
	if updated || err == nil {
		t.Fatalf("unsafe update = updated %t, err %v", updated, err)
	}
	body, _ := os.ReadFile(filepath.Join(home, ".claude", "skills", "tdd", "SKILL.md"))
	if string(body) != "old body" {
		t.Fatalf("last-good manifest changed: %q", body)
	}
	if fileExists(filepath.Join(home, ".claude", "skills", "escape")) {
		t.Fatal("unsafe auxiliary path escaped the skill directory")
	}
	if got := skillDigestsForRequest()["tdd"]; got != old.SHA256 {
		t.Fatalf("last-good digest = %q", got)
	}
}

func TestApplyClaudeSkillsRejectsCaseFoldedDuplicateBundlePaths(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	item := skillItem("tdd", "bundle", "body")
	setSkillFiles(&item,
		skillFile("Guide.md", "one"),
		skillFile("guide.md", "two"),
	)
	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{item}, slog.Default())
	if updated || err == nil {
		t.Fatalf("case-fold collision = updated %t, err %v", updated, err)
	}
	if fileExists(filepath.Join(home, ".claude", "skills", "tdd")) {
		t.Fatal("invalid bundle left a partial skill directory")
	}
}

func TestApplyClaudeSkillsRejectsInvalidManifestDigest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	item := skillItem("tdd", "bundle", "body")
	setSkillFiles(&item, skillFile("guide.md", "guide"))
	item.ManifestSHA256 = strings.Repeat("0", 64)
	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{item}, slog.Default())
	if updated || err == nil {
		t.Fatalf("invalid manifest digest = updated %t, err %v", updated, err)
	}
	if fileExists(filepath.Join(home, ".claude", "skills", "tdd")) {
		t.Fatal("invalid manifest digest left a partial skill directory")
	}
}

func TestApplyClaudeSkillsRejectsManifestOnlyAdvertisedDigestMismatch(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	item := skillItem("tdd", "ignored", "body")
	item.SHA256 = strings.Repeat("0", 64)
	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{item}, slog.Default())
	if updated || err == nil {
		t.Fatalf("manifest digest mismatch = updated %t, err %v", updated, err)
	}
	if fileExists(filepath.Join(home, ".claude", "skills", "tdd")) {
		t.Fatal("invalid manifest-only payload left a partial skill directory")
	}
}

func TestApplyClaudeSkillsRejectsAggregateBundleDigestAndPreservesLastGood(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	old := skillItem("tdd", "ignored", "old body")
	if updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{old}, logger); !updated || err != nil {
		t.Fatalf("seed last good = updated %t, err %v", updated, err)
	}

	next := skillItem("tdd", "ignored", "new body")
	setSkillFiles(&next, skillFile("guide.md", "valid file"))
	next.SHA256 = strings.Repeat("0", 64)
	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{next}, logger)
	if updated || err == nil {
		t.Fatalf("aggregate bundle digest mismatch = updated %t, err %v", updated, err)
	}
	root := filepath.Join(home, ".claude", "skills", "tdd")
	body, readErr := os.ReadFile(filepath.Join(root, "SKILL.md"))
	if readErr != nil || string(body) != "old body" || fileExists(filepath.Join(root, "guide.md")) {
		t.Fatalf("last good bundle changed: body %q, readErr %v", body, readErr)
	}
	if got := skillDigestsForRequest()["tdd"]; got != old.SHA256 {
		t.Fatalf("last good digest = %q, want %q", got, old.SHA256)
	}
}

func TestCanonicalSkillBundleDigestUsesUTF8ByteOrdering(t *testing.T) {
	manifestSHA := strings.Repeat("a", 64)
	files := map[string]string{
		"ä.md": strings.Repeat("b", 64),
		"z.md": strings.Repeat("c", 64),
	}
	hash := sha256.New()
	for _, entry := range []struct {
		path string
		sha  string
	}{
		{path: "SKILL.md", sha: manifestSHA},
		{path: "z.md", sha: files["z.md"]},
		{path: "ä.md", sha: files["ä.md"]},
	} {
		_, _ = hash.Write([]byte(entry.path))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(entry.sha))
		_, _ = hash.Write([]byte{'\n'})
	}
	want := fmt.Sprintf("%x", hash.Sum(nil))
	if got := canonicalSkillBundleDigest(manifestSHA, files); got != want {
		t.Fatalf("canonical bundle digest = %q, want %q", got, want)
	}
}

func TestApplyClaudeSkillsPreservesUnmanagedSlugCollision(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userDir := filepath.Join(home, ".claude", "skills", "tdd")
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userDir, "SKILL.md"), []byte("user-owned"), 0o644); err != nil {
		t.Fatal(err)
	}
	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{
		skillItem("tdd", "fleet", "fleet-owned"),
	}, slog.Default())
	if updated || err == nil {
		t.Fatalf("unmanaged collision = updated %t, err %v", updated, err)
	}
	body, readErr := os.ReadFile(filepath.Join(userDir, "SKILL.md"))
	if readErr != nil || string(body) != "user-owned" {
		t.Fatalf("unmanaged directory changed: body %q, err %v", body, readErr)
	}
	if len(skillDigestsForRequest()) != 0 {
		t.Fatal("unmanaged directory was adopted into fleet ownership")
	}
}

func TestApplyClaudeSkillsInvalidOwnershipRecordCannotOverwriteUserDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userDir := filepath.Join(home, ".claude", "skills", "a")
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userDir, "SKILL.md"), []byte("user-owned"), 0o644); err != nil {
		t.Fatal(err)
	}
	invalid := collectionManifest{Version: 1, Items: map[string]manifestEntry{
		"a": {Filename: filepath.Join("b", "SKILL.md"), SHA256: strings.Repeat("1", 64)},
	}}
	if err := saveManifest(collectionManifestPath("skills"), invalid); err != nil {
		t.Fatal(err)
	}

	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{
		skillItem("a", "ignored", "fleet-owned"),
	}, slog.Default())
	if updated || err == nil {
		t.Fatalf("invalid ownership update = updated %t, err %v", updated, err)
	}
	body, readErr := os.ReadFile(filepath.Join(userDir, "SKILL.md"))
	if readErr != nil || string(body) != "user-owned" {
		t.Fatalf("invalid ownership overwrote user skill: body %q, err %v", body, readErr)
	}
	if got := loadManifest(collectionManifestPath("skills")).Items["a"].Filename; got != filepath.Join("b", "SKILL.md") {
		t.Fatalf("invalid ownership record was adopted or discarded: %q", got)
	}
}

func TestApplyClaudeSkillsMissingAuxiliaryClearsDigestForNextHeal(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	full := skillItem("tdd", "bundle", "body")
	setSkillFiles(&full, skillFile("tests.md", "reference"))
	applyClaudeSkills([]orchestrator.CollectionItem{full}, logger)
	if err := os.Remove(filepath.Join(home, ".claude", "skills", "tdd", "tests.md")); err != nil {
		t.Fatal(err)
	}
	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{{
		Slug: "tdd", SHA256: full.SHA256, Status: "unchanged",
	}}, logger)
	if updated || err == nil {
		t.Fatalf("missing-file probe = updated %t, err %v", updated, err)
	}
	if got := skillDigestsForRequest()["tdd"]; got != "" {
		t.Fatalf("missing bundle still advertised digest %q", got)
	}
	updated, err = applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{full}, logger)
	if !updated || err != nil || !fileExists(filepath.Join(home, ".claude", "skills", "tdd", "tests.md")) {
		t.Fatalf("bundle did not self-heal = updated %t, err %v", updated, err)
	}
}

func TestSkillDigestsForRequestWithholdsModifiedManagedContentAndSelfHeals(t *testing.T) {
	tests := []struct {
		name       string
		tamperPath string
		tampered   string
		want       string
	}{
		{name: "manifest", tamperPath: "SKILL.md", tampered: "locally modified manifest", want: "body"},
		{name: "auxiliary", tamperPath: "tests.md", tampered: "locally modified reference", want: "reference"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			logger := slog.Default()
			full := skillItem("tdd", "bundle", "body")
			setSkillFiles(&full, skillFile("tests.md", "reference"))
			applyClaudeSkills([]orchestrator.CollectionItem{full}, logger)

			target := filepath.Join(home, ".claude", "skills", "tdd", tc.tamperPath)
			if err := os.WriteFile(target, []byte(tc.tampered), 0o644); err != nil {
				t.Fatal(err)
			}
			if _, advertised := skillDigestsForRequest()["tdd"]; advertised {
				t.Fatalf("modified %s still advertised the cached bundle digest", tc.tamperPath)
			}

			updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{full}, logger)
			if !updated || err != nil {
				t.Fatalf("modified bundle did not self-heal: updated %t, err %v", updated, err)
			}
			body, err := os.ReadFile(target)
			if err != nil || string(body) != tc.want {
				t.Fatalf("healed %s = %q, err %v", tc.tamperPath, body, err)
			}
			if got := skillDigestsForRequest()["tdd"]; got != full.SHA256 {
				t.Fatalf("healed bundle digest = %q", got)
			}
		})
	}
}

func TestSkillDigestsRejectExtraEntriesAndSelfHealExactBundle(t *testing.T) {
	tests := []struct {
		name string
		add  func(t *testing.T, root string) string
	}{
		{
			name: "file",
			add: func(t *testing.T, root string) string {
				t.Helper()
				p := filepath.Join(root, "extra.sh")
				if err := os.WriteFile(p, []byte("echo injected"), 0o644); err != nil {
					t.Fatal(err)
				}
				return p
			},
		},
		{
			name: "directory",
			add: func(t *testing.T, root string) string {
				t.Helper()
				p := filepath.Join(root, "extra")
				if err := os.Mkdir(p, 0o755); err != nil {
					t.Fatal(err)
				}
				return p
			},
		},
		{
			name: "symlink",
			add: func(t *testing.T, root string) string {
				t.Helper()
				p := filepath.Join(root, "extra-link")
				if err := os.Symlink("SKILL.md", p); err != nil {
					t.Fatal(err)
				}
				return p
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			logger := slog.Default()
			full := skillItem("tdd", "ignored", "body")
			setSkillFiles(&full, skillFile("refs/guide.md", "guide"))
			if updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{full}, logger); !updated || err != nil {
				t.Fatalf("seed bundle = updated %t, err %v", updated, err)
			}
			root := filepath.Join(home, ".claude", "skills", "tdd")
			extra := tc.add(t, root)
			if _, advertised := skillDigestsForRequest()["tdd"]; advertised {
				t.Fatalf("bundle with extra %s still advertised a digest", tc.name)
			}
			updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{full}, logger)
			if !updated || err != nil {
				t.Fatalf("extra %s did not self-heal: updated %t, err %v", tc.name, updated, err)
			}
			if _, err := os.Lstat(extra); !os.IsNotExist(err) {
				t.Fatalf("extra %s survived exact bundle swap: %v", tc.name, err)
			}
			if got := skillDigestsForRequest()["tdd"]; got != full.SHA256 {
				t.Fatalf("healed digest = %q, want %q", got, full.SHA256)
			}
		})
	}
}

func TestSkillDigestsForRequestUpgradesLegacyOwnershipManifest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, ".claude", "skills", "legacy")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "SKILL.md"), []byte("body"), 0o644); err != nil {
		t.Fatal(err)
	}
	legacy := collectionManifest{
		Version: 1,
		Items: map[string]manifestEntry{
			"legacy": {Filename: filepath.Join("legacy", "SKILL.md"), SHA256: "bundle"},
		},
	}
	if err := saveManifest(collectionManifestPath("skills"), legacy); err != nil {
		t.Fatal(err)
	}
	if _, advertised := skillDigestsForRequest()["legacy"]; advertised {
		t.Fatal("legacy ownership without content hashes must force a full bundle refresh")
	}

	full := skillItem("legacy", "bundle", "body")
	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{full}, slog.Default())
	if !updated || err != nil {
		t.Fatalf("legacy ownership upgrade = updated %t, err %v", updated, err)
	}
	rec := loadManifest(collectionManifestPath("skills")).Items["legacy"]
	if rec.ManifestSHA256 == "" || skillDigestsForRequest()["legacy"] != full.SHA256 {
		t.Fatalf("legacy ownership was not upgraded with integrity metadata: %+v", rec)
	}
}

func TestApplyClaudeSkillsIfNoneMatch(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	first := skillItem("a", "sha-a", "v1")
	applyClaudeSkills([]orchestrator.CollectionItem{first}, logger)
	updated := applyClaudeSkills([]orchestrator.CollectionItem{
		{Slug: "a", SHA256: first.SHA256, Status: "unchanged"},
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
	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{{
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
	old := skillItem("reviewer", "old", "old body")
	applyClaudeSkills([]orchestrator.CollectionItem{old}, logger)

	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{{
		Slug: "reviewer", SHA256: "new", Status: "updated",
	}}, logger)
	if updated || err == nil {
		t.Fatalf("incomplete skill update = updated %t, err %v", updated, err)
	}
	body, readErr := os.ReadFile(filepath.Join(home, ".claude", "skills", "reviewer", "SKILL.md"))
	if readErr != nil || string(body) != "old body" {
		t.Fatalf("last good skill was not preserved: body %q, err %v", body, readErr)
	}
	if got := loadManifest(collectionManifestPath("skills")).Items["reviewer"].SHA256; got != old.SHA256 {
		t.Fatalf("last good skill manifest SHA = %q", got)
	}
}

func TestApplyClaudeSkillsNilLegacyPayloadDoesNotPrune(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	applyClaudeSkills([]orchestrator.CollectionItem{skillItem("reviewer", "sha", "body")}, logger)

	updated, err := applyClaudeSkillsResult(context.Background(), nil, logger)
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

func TestApplyClaudeSkillsInvalidOwnershipRecordCannotPruneAnotherSlug(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userDir := filepath.Join(home, ".claude", "skills", "user-b")
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userDir, "SKILL.md"), []byte("user-owned"), 0o644); err != nil {
		t.Fatal(err)
	}
	invalid := collectionManifest{Version: 1, Items: map[string]manifestEntry{
		"fleet-a": {Filename: filepath.Join("user-b", "SKILL.md"), SHA256: strings.Repeat("1", 64)},
	}}
	if err := saveManifest(collectionManifestPath("skills"), invalid); err != nil {
		t.Fatal(err)
	}

	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{}, slog.Default())
	if updated || err == nil {
		t.Fatalf("invalid ownership prune = updated %t, err %v", updated, err)
	}
	if !fileExists(filepath.Join(userDir, "SKILL.md")) {
		t.Fatal("invalid ownership record pruned another user-owned slug")
	}
	if _, retained := loadManifest(collectionManifestPath("skills")).Items["fleet-a"]; !retained {
		t.Fatal("invalid ownership record was discarded instead of quarantined")
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
	item := skillItem("a", "sha-a", "A")
	applyClaudeSkills([]orchestrator.CollectionItem{item}, logger)
	d := skillDigestsForRequest()
	if d["a"] != item.SHA256 {
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

func TestStripClaudeSkillsInvalidOwnershipRecordCannotRemoveAnotherSlug(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userDir := filepath.Join(home, ".claude", "skills", "user-b")
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userDir, "SKILL.md"), []byte("user-owned"), 0o644); err != nil {
		t.Fatal(err)
	}
	invalid := collectionManifest{Version: 1, Items: map[string]manifestEntry{
		"fleet-a": {Filename: filepath.Join("user-b", "SKILL.md"), SHA256: strings.Repeat("1", 64)},
	}}
	if err := saveManifest(collectionManifestPath("skills"), invalid); err != nil {
		t.Fatal(err)
	}

	err := stripClaudeSkills(slog.Default())
	if err == nil {
		t.Fatal("strip accepted an invalid ownership record")
	}
	if !fileExists(filepath.Join(userDir, "SKILL.md")) {
		t.Fatal("invalid ownership record stripped another user-owned slug")
	}
	if _, retained := loadManifest(collectionManifestPath("skills")).Items["fleet-a"]; !retained {
		t.Fatal("invalid ownership record was discarded after strip")
	}
}

func TestStripClaudeSkillsRetainsOwnershipAfterRemoveFailure(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	path := filepath.Join(home, ".claude", "skills", "a", "SKILL.md")
	item := skillItem("a", "1", "A")
	applyClaudeSkills([]orchestrator.CollectionItem{item}, logger)
	err := stripClaudeSkillsWith(logger, func(string) error { return errors.New("busy") })
	if err == nil || !fileExists(path) || skillDigestsForRequest()["a"] != item.SHA256 {
		t.Fatalf("failed skill strip lost ownership: err=%v digests=%v", err, skillDigestsForRequest())
	}
	if err := stripClaudeSkills(logger); err != nil {
		t.Fatalf("retry skill strip: %v", err)
	}
	if fileExists(path) || len(skillDigestsForRequest()) != 0 {
		t.Fatalf("retry did not clear skill and ownership: digests=%v", skillDigestsForRequest())
	}
}

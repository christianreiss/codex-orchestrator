package skillstore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newStore(t *testing.T) Store {
	t.Helper()
	dir := t.TempDir()
	return Store{Root: filepath.Join(dir, "skills"), ManifestPath: filepath.Join(dir, "state", "skills.json"), Label: "Grok"}
}

func plain(slug, body string) Item {
	return Item{Slug: slug, SHA256: digest(body), Status: "updated", Content: body}
}

func read(t *testing.T, p string) string {
	t.Helper()
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestApplyWritesUnchangedAndPrunesOnlyOwnedSkills(t *testing.T) {
	s := newStore(t)
	body := "---\nname: afk\ndescription: x\n---\n\nbody\n"
	updated, err := s.Apply([]Item{plain("afk", body)})
	if err != nil || !updated {
		t.Fatalf("first apply: updated=%v err=%v", updated, err)
	}
	if got := read(t, filepath.Join(s.Root, "afk", "SKILL.md")); got != body {
		t.Fatalf("SKILL.md = %q", got)
	}
	if got := s.Digests(); got["afk"] != digest(body) {
		t.Fatalf("digests = %v", got)
	}
	// If-None-Match: the server omits content for an unchanged digest.
	updated, err = s.Apply([]Item{{Slug: "afk", SHA256: digest(body), Status: "unchanged"}})
	if err != nil || updated {
		t.Fatalf("unchanged apply: updated=%v err=%v", updated, err)
	}
	// A user directory next to fleet skills must survive pruning.
	user := filepath.Join(s.Root, "mine")
	if err := os.MkdirAll(user, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(user, "SKILL.md"), []byte("user"), 0o644); err != nil {
		t.Fatal(err)
	}
	updated, err = s.Apply([]Item{})
	if err != nil || !updated {
		t.Fatalf("prune apply: updated=%v err=%v", updated, err)
	}
	if exists(filepath.Join(s.Root, "afk")) {
		t.Fatal("owned skill was not pruned")
	}
	if read(t, filepath.Join(user, "SKILL.md")) != "user" {
		t.Fatal("user skill was touched")
	}
	// nil means an older server sent no bundle: nothing changes.
	if updated, err := s.Apply(nil); err != nil || updated {
		t.Fatalf("nil apply: updated=%v err=%v", updated, err)
	}
}

func TestApplyRefusesUnmanagedDirectoriesAndBadDigests(t *testing.T) {
	s := newStore(t)
	if err := os.MkdirAll(filepath.Join(s.Root, "taken"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := s.Apply([]Item{plain("taken", "fleet"), {Slug: "bad", SHA256: strings.Repeat("0", 64), Content: "tampered"}, plain("../escape", "x")})
	if err == nil {
		t.Fatal("expected errors")
	}
	for _, want := range []string{"conflicts with an unmanaged local directory", "does not match advertised sha256", "unsafe slug"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q lacks %q", err, want)
		}
	}
	if exists(filepath.Join(s.Root, "taken", "SKILL.md")) || exists(filepath.Join(s.Root, "bad")) {
		t.Fatal("refused skills were written")
	}
}

func TestApplyVerifiesDirectoryBundlesAndHealsDrift(t *testing.T) {
	s := newStore(t)
	manifestBody := "---\nname: tool\ndescription: x\n---\n"
	script := "#!/bin/sh\necho hi\n"
	files := map[string]string{"scripts/run.sh": digest(script)}
	item := Item{Slug: "tool", Status: "updated", Content: manifestBody, ManifestSHA256: digest(manifestBody), SHA256: bundleDigest(digest(manifestBody), files), Files: []File{{Path: "scripts/run.sh", SHA256: digest(script), Content: script}}}
	if _, err := s.Apply([]Item{item}); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(s.Root, "tool", "scripts", "run.sh")) != script {
		t.Fatal("auxiliary file missing")
	}
	// An injected extra file withholds the digest so the server resends the bundle.
	if err := os.WriteFile(filepath.Join(s.Root, "tool", "extra"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Digests()["tool"]; ok {
		t.Fatal("drifted bundle still advertised")
	}
	if updated, err := s.Apply([]Item{item}); err != nil || !updated {
		t.Fatalf("heal: updated=%v err=%v", updated, err)
	}
	if exists(filepath.Join(s.Root, "tool", "extra")) {
		t.Fatal("drift survived")
	}
	// A bundle whose aggregate digest does not match is rejected wholesale.
	broken := item
	broken.SHA256 = strings.Repeat("a", 64)
	if _, err := s.Apply([]Item{broken}); err == nil || !strings.Contains(err.Error(), "bundle does not match") {
		t.Fatalf("expected aggregate mismatch, got %v", err)
	}
	if read(t, filepath.Join(s.Root, "tool", "SKILL.md")) != manifestBody {
		t.Fatal("previous bundle was not kept")
	}
}

func TestStripRemovesOnlyOwnedSkillsAndTheManifest(t *testing.T) {
	s := newStore(t)
	if _, err := s.Apply([]Item{plain("a", "one"), plain("b", "two")}); err != nil {
		t.Fatal(err)
	}
	user := filepath.Join(s.Root, "user")
	if err := os.MkdirAll(user, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := s.Strip(); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(s.Root, "a")) || exists(filepath.Join(s.Root, "b")) || exists(s.ManifestPath) {
		t.Fatal("strip left fleet state behind")
	}
	if !exists(user) {
		t.Fatal("strip removed a user directory")
	}
}

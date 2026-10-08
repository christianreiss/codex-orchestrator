package memoryrouting

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path string, body []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o640); err != nil {
		t.Fatal(err)
	}
}
func read(t *testing.T, path string) []byte {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return body
}
func chdir(t *testing.T, path string) {
	t.Helper()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(path); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previous); err != nil {
			t.Fatal(err)
		}
	})
}

func TestCodexPreservesNotesAndModesAcrossSyncAndDisable(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "memories", "MEMORY.md")
	original := []byte("# User notes\r\n\nExact whitespace\t\n\n")
	write(t, path, original)
	for _, content := range []string{"first", "first", "updated"} {
		changed, err := Apply("codex", home, &Bundle{Enabled: true, Content: content}, nil)
		if err != nil {
			t.Fatal(err)
		}
		body := read(t, path)
		if !bytes.HasSuffix(body, original) || bytes.Count(body, []byte(Start)) != 1 || !bytes.Contains(body, []byte(content)) {
			t.Fatalf("notes lost or duplicate: %q", body)
		}
		if content == "updated" && !changed {
			t.Fatal("replacement not reported")
		}
	}
	if changed, err := Apply("codex", home, &Bundle{Enabled: true, Content: "updated"}, nil); err != nil || changed {
		t.Fatalf("unchanged = %v, %v", changed, err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o640 {
		t.Fatal("user mode changed")
	}
	if _, err := Apply("codex", home, &Bundle{}, nil); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(read(t, path), original) {
		t.Fatal("disable changed notes")
	}
	if len(read(t, filepath.Join(home, "memories", "memory_summary.md"))) != 0 {
		t.Fatal("summary reminder survived disable")
	}
}

func TestOlderServerDoesNotTouchNativeHome(t *testing.T) {
	home := filepath.Join(t.TempDir(), "missing")
	if changed, err := Apply("codex", home, nil, nil); changed || err != nil {
		t.Fatalf("%v, %v", changed, err)
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatal("nil bundle mutated home")
	}
}

func TestStripRepairsDuplicateBlocksAndRejectsBrokenMarkers(t *testing.T) {
	block := Start + "\nold\n" + End + "\n\n"
	body, err := strip([]byte(block + block + "existing notes\n"))
	if err != nil || string(body) != "existing notes\n" {
		t.Fatalf("%q %v", body, err)
	}
	for _, malformed := range []string{Start + "notes", End, Start + Start + End} {
		if _, err := strip([]byte(malformed)); err == nil {
			t.Fatalf("accepted malformed %q", malformed)
		}
	}
}

func TestApplyRefusesSymlinkAndPreservesFailedOwnershipForRetry(t *testing.T) {
	home := t.TempDir()
	outside := filepath.Join(t.TempDir(), "MEMORY.md")
	write(t, outside, []byte("untouched"))
	path := filepath.Join(home, "memories", "MEMORY.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply("codex", home, &Bundle{Enabled: true, Content: "hint"}, nil); err == nil {
		t.Fatal("symlink write accepted")
	}
	if string(read(t, outside)) != "untouched" {
		t.Fatal("symlink referent changed")
	}
	if !bytes.Contains(read(t, filepath.Join(home, manifestName)), []byte("MEMORY.md")) {
		t.Fatal("retry ownership lost")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply("codex", home, &Bundle{Enabled: true, Content: "hint"}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestStaleSnapshotNeverOverwritesNativeMemory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "MEMORY.md")
	write(t, path, []byte("native update"))
	if err := replaceRegular(path, []byte("old"), []byte("replacement")); err == nil {
		t.Fatal("stale snapshot accepted")
	}
	if string(read(t, path)) != "native update" {
		t.Fatal("native update overwritten")
	}
}

func TestGrokScopesAndGeneratedIndexRecovery(t *testing.T) {
	home := t.TempDir()
	workspace := filepath.Join(home, "memory-v2", "workspaces", "repo-ab12", "MEMORY.md")
	legacy := filepath.Join(home, "memory", "workspaces", "repo-ab12", "MEMORY.md")
	for _, path := range []string{workspace, legacy} {
		write(t, path, []byte("local workspace notes\n"))
	}
	bundle := &Bundle{Enabled: true, Content: "Use shared_memory_search through MCP"}
	if _, err := Apply("grok", home, bundle, nil); err != nil {
		t.Fatal(err)
	}
	topic := filepath.Join(home, "memory-v2", "global", "topics", topicName)
	if !bytes.Contains(read(t, topic), []byte("shared_memory_search")) {
		t.Fatal("v2 topic missing")
	}
	write(t, workspace, []byte("regenerated index\n"))
	if _, err := Apply("grok", home, bundle, nil); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasSuffix(read(t, workspace), []byte("regenerated index\n")) {
		t.Fatal("generated content lost")
	}
	if _, err := Apply("grok", home, &Bundle{}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(topic); !os.IsNotExist(err) {
		t.Fatal("owned topic not removed")
	}
	if string(read(t, workspace)) != "regenerated index\n" {
		t.Fatal("workspace notes changed during disable")
	}
}

func TestClaudeCustomDirectoryAndOldLocationCleanup(t *testing.T) {
	userHome := t.TempDir()
	home := filepath.Join(userHome, ".claude")
	chdir(t, userHome)
	custom := filepath.Join(userHome, "custom")
	settings, _ := json.Marshal(map[string]string{"autoMemoryDirectory": "~/custom"})
	write(t, filepath.Join(home, "settings.json"), settings)
	write(t, filepath.Join(custom, "MEMORY.md"), []byte("custom notes\n"))
	other := filepath.Join(home, "projects", "old-project", "memory", "MEMORY.md")
	write(t, other, []byte("other project notes\n"))
	if _, err := Apply("claude", home, &Bundle{Enabled: true, Content: "hint"}, nil); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(read(t, filepath.Join(custom, "MEMORY.md")), []byte(Start)) || !bytes.Contains(read(t, other), []byte(Start)) {
		t.Fatal("custom or existing project missed")
	}
	if _, err := Apply("claude", home, &Bundle{Enabled: true, Content: "new hint"}, []string{"--settings", `{"autoMemoryDirectory":"` + filepath.Join(userHome, "second") + `"}`}); err != nil {
		t.Fatal(err)
	}
	if string(read(t, filepath.Join(custom, "MEMORY.md"))) != "custom notes\n" {
		t.Fatal("old custom ownership not cleaned")
	}
	// A changed user setting must not prevent removal at a previously owned path.
	write(t, filepath.Join(home, "settings.json"), []byte(`{"autoMemoryDirectory":"relative-invalid"}`))
	if _, err := Apply("claude", home, &Bundle{}, nil); err != nil {
		t.Fatal(err)
	}
	if len(read(t, filepath.Join(userHome, "second", "MEMORY.md"))) != 0 {
		t.Fatal("tracked custom pointer survived")
	}
}

func TestClaudeRepoSubdirectoryAndWorktreeShareNativeRoot(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	repo := filepath.Join(root, "repo")
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git: %s %v", out, err)
		}
	}
	git("init", "-q", repo)
	git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "--no-gpg-sign", "-qm", "fixture")
	worktree := filepath.Join(root, "worktree")
	git("-C", repo, "worktree", "add", "--detach", "-q", worktree)
	sub := filepath.Join(worktree, "sub")
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	chdir(t, sub)
	home := filepath.Join(root, ".claude")
	dir, err := claudeMemoryDir(home, nil)
	if err != nil || dir != filepath.Join(home, "projects", claudeProjectKey(repo), "memory") {
		t.Fatalf("native worktree root = %s, %v", dir, err)
	}
	// A path selector in this worktree must win over a different main checkout.
	write(t, filepath.Join(repo, ".claude", "settings.local.json"), []byte(`{"autoMemoryDirectory":"/wrong-checkout"}`))
	selected := filepath.Join(root, "worktree-memory")
	settings, _ := json.Marshal(map[string]string{"autoMemoryDirectory": selected})
	write(t, filepath.Join(worktree, ".claude", "settings.local.json"), settings)
	trust, _ := json.Marshal(map[string]any{"projects": map[string]any{worktree: map[string]bool{"hasTrustDialogAccepted": true}}})
	write(t, filepath.Join(root, ".claude.json"), trust)
	dir, err = claudeMemoryDir(home, nil)
	if err != nil || dir != selected {
		t.Fatalf("active worktree settings missed: %s %v", dir, err)
	}
	dir, err = claudeMemoryDir(home, []string{"--setting-sources", "user"})
	if err != nil || dir != filepath.Join(home, "projects", claudeProjectKey(repo), "memory") {
		t.Fatalf("excluded local settings applied: %s %v", dir, err)
	}
}

func TestClaudeUntrustedRepoCannotRedirectMemory(t *testing.T) {
	root := t.TempDir()
	chdir(t, root)
	home := filepath.Join(root, ".claude")
	write(t, filepath.Join(home, "settings.json"), []byte(`{"autoMemoryDirectory":"~/safe"}`))
	write(t, filepath.Join(root, ".claude", "settings.local.json"), []byte(`{"autoMemoryDirectory":"/untrusted"}`))
	dir, err := claudeMemoryDir(home, nil)
	if err != nil || dir != filepath.Join(root, "safe") {
		t.Fatalf("untrusted selector applied: %s, %v", dir, err)
	}
}

func TestClaudeLongProjectKeyMatchesNativeHash(t *testing.T) {
	key := claudeProjectKey("/" + strings.Repeat("a", 250))
	// Native JS: sanitized.slice(0,200) + '-' + Math.abs(hash32(path)).toString(36).
	if key != "-"+strings.Repeat("a", 199)+"-feo44x" {
		t.Fatalf("native project key mismatch: %s", key)
	}
}

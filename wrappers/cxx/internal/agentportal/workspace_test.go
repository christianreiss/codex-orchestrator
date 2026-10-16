package agentportal

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestLaunchCwd(t *testing.T) {
	cwd, _ := os.Getwd()
	for _, tc := range []struct {
		engine string
		args   []string
		want   string
	}{
		{"codex", []string{"exec", "--cd", "/tmp/project", "Task"}, "/tmp/project"},
		{"codex", []string{"resume", "native-id", "--cd=/tmp/project"}, "/tmp/project"},
		{"codex", []string{"-C/tmp/project"}, "/tmp/project"},
		{"codex", []string{"--cd", "relative"}, filepath.Join(cwd, "relative")},
		{"codex", []string{"--", "--cd", "/not-a-directory-option"}, cwd},
		{"codex", []string{"-c", "--cd=/prompt-value"}, cwd},
		{"codex", []string{"--model", "--cd", "Task"}, cwd},
		{"claude", []string{"--append-system-prompt", "--cd=/prompt-value"}, cwd},
		{"grok", []string{"--cwd=/tmp/project", "--resume"}, "/tmp/project"},
		{"grok", []string{"--cwd", "/tmp/project"}, "/tmp/project"},
		{"grok", []string{"-p", "--cwd=/prompt-value"}, cwd},
	} {
		got, err := launchCwd(tc.engine, tc.args)
		if err != nil || got != tc.want {
			t.Fatalf("%s %v: got %q err %v want %q", tc.engine, tc.args, got, err, tc.want)
		}
	}
}

func TestCaptureWorkspace(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s %v", args, out, err)
		}
	}
	if got := captureWorkspace(context.Background(), dir); got.GitStatus != "none" {
		t.Fatal(got)
	}
	git("init", "-q")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fixture")
	git("remote", "add", "origin", "https://user:secret@example.org/team/repo.git?token=secret#secret")
	child := filepath.Join(dir, "api")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(child, alias); err != nil {
		t.Fatal(err)
	}
	w := captureWorkspace(context.Background(), alias)
	if w.GitStatus != "repository" || w.Cwd != canonicalPath(child) || *w.GitRoot != canonicalPath(dir) || *w.GitCommonDir != canonicalPath(filepath.Join(dir, ".git")) || *w.OriginURL != "https://example.org/team/repo.git" {
		t.Fatalf("%+v", w)
	}
	linked := filepath.Join(t.TempDir(), "linked")
	git("worktree", "add", "--detach", linked)
	w = captureWorkspace(context.Background(), linked)
	if w.GitStatus != "repository" || *w.GitRoot != canonicalPath(linked) || *w.GitCommonDir != canonicalPath(filepath.Join(dir, ".git")) {
		t.Fatalf("%+v", w)
	}
	git("config", "url.https://example.org/team/.insteadOf", "fleet:")
	git("remote", "set-url", "origin", "fleet:repo.git")
	if got := captureWorkspace(context.Background(), dir); got.OriginURL == nil || *got.OriginURL != "https://example.org/team/repo.git" {
		t.Fatal("origin rewrite not resolved", got)
	}
	git("remote", "remove", "origin")
	if got := captureWorkspace(context.Background(), dir); got.GitStatus != "repository" || got.OriginURL != nil {
		t.Fatal(got)
	}
	t.Setenv("PATH", t.TempDir())
	if got := captureWorkspace(context.Background(), dir); got.GitStatus != "unavailable" {
		t.Fatal(got)
	}
}

func TestDiscoveryOrigin(t *testing.T) {
	for raw, want := range map[string]string{
		"https://u:secret@example.org/repo.git?token=secret#secret": "https://example.org/repo.git",
		"ssh://git@example.org:2222/team/repo.git":                  "ssh://example.org:2222/team/repo.git",
		"git@example.org:team/repo.git":                             "example.org:team/repo.git",
		"/srv/repo":                                                 "", "file:///srv/repo": "", "../repo": "", "ext::bad": "",
	} {
		got := discoveryOrigin(raw)
		if got != want || strings.Contains(got, "secret") {
			t.Fatalf("%q => %q want %q", raw, got, want)
		}
	}
}

func TestWorkspaceUsesNativeValueCardinality(t *testing.T) {
	cwd, _ := os.Getwd()
	for _, args := range [][]string{{"--print", "--cwd=/fake"}, {"--debug-file", "--cwd=/fake"}, {"--json-schema", "--cwd=/fake"}, {"--worktree", "--cwd=/actual"}, {"--single=--cwd=/fake", "--cwd=/actual"}} {
		want := cwd
		if args[len(args)-1] == "--cwd=/actual" {
			want = "/actual"
		}
		got, err := launchCwd("grok", args)
		if err != nil || got != want {
			t.Errorf("%q => %q %v want %q", args, got, err, want)
		}
	}
	for _, args := range [][]string{{"--image", "a.png", "login", "resume"}, {"--image", "a.png", "--cd", "/actual"}} {
		want := cwd
		if args[len(args)-1] == "/actual" {
			want = "/actual"
		}
		got, err := launchCwd("codex", args)
		if err != nil || got != want {
			t.Errorf("%q => %q %v", args, got, err)
		}
	}
}

package nativeentry

import (
	"context"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestInstallRoundTripAndArguments(t *testing.T) {
	home := t.TempDir()
	for _, n := range []string{".bashrc", ".zshrc", ".config/fish/config.fish"} {
		p := filepath.Join(home, n)
		os.MkdirAll(filepath.Dir(p), 0700)
		os.WriteFile(p, []byte("# user\n"), 0600)
	}
	wrapper := filepath.Join(home, "wrapper with ' quote")
	os.WriteFile(wrapper, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0700)
	opts := Options{Home: home, WrapperPath: wrapper, Engines: []string{"codex", "claude", "grok"}}
	if e := Install(opts); e != nil {
		t.Fatal(e)
	}
	before, _ := os.ReadFile(filepath.Join(home, ".bashrc"))
	if e := Install(opts); e != nil {
		t.Fatal(e)
	}
	after, _ := os.ReadFile(filepath.Join(home, ".bashrc"))
	if string(before) != string(after) {
		t.Fatal("not idempotent")
	}
	for _, engine := range opts.Engines {
		out, e := exec.Command(filepath.Join(BinDir(home), engine), "a b", "$literal", "both ' and \" quotes", "--").Output()
		if e != nil {
			t.Fatal(e)
		}
		if string(out) != "native\n"+engine+"\n--\na b\n$literal\nboth ' and \" quotes\n--\n" {
			t.Fatalf("argv %q", out)
		}
	}
	if e := Remove(opts); e != nil {
		t.Fatal(e)
	}
	for _, n := range []string{".bashrc", ".zshrc", ".config/fish/config.fish"} {
		b, _ := os.ReadFile(filepath.Join(home, n))
		if string(b) != "# user\n" {
			t.Fatalf("user content %q", b)
		}
	}
}
func TestInstallAdditiveSyncAuthoritative(t *testing.T) {
	home := t.TempDir()
	for _, e := range []string{"codex", "claude"} {
		if err := Install(Options{home, "/usr/bin/cxx", []string{e}}); err != nil {
			t.Fatal(err)
		}
	}
	if !IsManagedShim(filepath.Join(BinDir(home), "codex")) {
		t.Fatal("singleton removed peer")
	}
	if err := Sync(home, "/usr/bin/cxx", []string{"grok"}); err != nil {
		t.Fatal(err)
	}
	if IsManagedShim(filepath.Join(BinDir(home), "codex")) {
		t.Fatal("obsolete shim kept")
	}
	if err := Remove(Options{Home: home, Engines: []string{"grok"}}); err != nil {
		t.Fatal(err)
	}
}
func TestUnmanagedEntries(t *testing.T) {
	home := t.TempDir()
	os.MkdirAll(BinDir(home), 0700)
	p := filepath.Join(BinDir(home), "codex")
	os.WriteFile(p, []byte("user"), 0700)
	if err := Install(Options{home, "/usr/bin/cxx", []string{"codex"}}); err == nil {
		t.Fatal("overwrote user")
	}
	b, _ := os.ReadFile(p)
	if string(b) != "user" {
		t.Fatal("changed")
	}
}
func TestResolutionAndAssignment(t *testing.T) {
	home := t.TempDir()
	wrapper := filepath.Join(home, "cxx")
	os.WriteFile(wrapper, []byte("wrapper"), 0700)
	Install(Options{home, wrapper, []string{"codex"}})
	alias := filepath.Join(home, "alias")
	vendor := filepath.Join(home, "vendor")
	os.Mkdir(alias, 0700)
	os.Mkdir(vendor, 0700)
	os.Symlink(wrapper, filepath.Join(alias, "codex"))
	expected := filepath.Join(vendor, "codex")
	os.WriteFile(expected, []byte("vendor"), 0700)
	t.Setenv("PATH", strings.Join([]string{BinDir(home), alias, vendor}, string(os.PathListSeparator)))
	got, e := ResolveVendor("codex", wrapper)
	if e != nil || got != expected {
		t.Fatalf("%s %v", got, e)
	}
	if !IsWrapperOrShim(filepath.Join(alias, "codex"), wrapper) {
		t.Fatal("alias guard")
	}
	if len(AssignedEngines(&config.Config{Engine: "codex"})) != 0 {
		t.Fatal("fallback")
	}
}

func TestPreflightAndDiagnostics(t *testing.T) {
	home := t.TempDir()
	os.MkdirAll(BinDir(home), 0700)
	collision := filepath.Join(BinDir(home), "grok")
	os.WriteFile(collision, []byte("user"), 0700)
	if err := Install(Options{home, "/usr/bin/cxx", []string{"codex", "grok"}}); err == nil {
		t.Fatal("collision accepted")
	}
	if _, err := os.Stat(filepath.Join(BinDir(home), "codex")); !os.IsNotExist(err) {
		t.Fatal("partial install")
	}
	os.Remove(collision)
	os.WriteFile(filepath.Join(home, ".bashrc"), []byte(blockStart+"\n"), 0600)
	if err := Install(Options{home, "/usr/bin/cxx", []string{"codex"}}); err == nil {
		t.Fatal("malformed block accepted")
	}
	if _, err := os.Stat(filepath.Join(BinDir(home), "codex")); !os.IsNotExist(err) {
		t.Fatal("partial malformed-block install")
	}
	os.Remove(filepath.Join(home, ".bashrc"))
	if err := Install(Options{home, "/usr/bin/cxx", []string{"codex"}}); err != nil {
		t.Fatal(err)
	}
	vendor := filepath.Join(home, "vendor")
	os.Mkdir(vendor, 0700)
	os.WriteFile(filepath.Join(vendor, "codex"), []byte("native"), 0700)
	t.Setenv("PATH", vendor+string(os.PathListSeparator)+BinDir(home))
	status := Diagnose(home)
	if status.PathActive || !status.ShellRestartRequired {
		t.Fatal(status)
	}
	t.Setenv("PATH", BinDir(home)+string(os.PathListSeparator)+vendor)
	status = Diagnose(home)
	if !status.PathActive || status.ShellRestartRequired {
		t.Fatal(status)
	}
}

func TestShellBlocksSourceIdempotentlyWithQuotedHome(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home with ' quote and \\ slash")
	if err := os.Mkdir(home, 0700); err != nil {
		t.Fatal(err)
	}
	if err := Install(Options{home, "/usr/bin/cxx", []string{"codex"}}); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ name, relative string }{{"bash", ".bashrc"}, {"zsh", ".zshrc"}, {"fish", ".config/fish/config.fish"}} {
		t.Run(item.name, func(t *testing.T) {
			shell, err := exec.LookPath(item.name)
			if err != nil {
				t.Skip("shell unavailable")
			}
			rc := filepath.Join(home, item.relative)
			if out, err := exec.Command(shell, "-n", rc).CombinedOutput(); err != nil {
				t.Fatalf("syntax: %v %s", err, out)
			}
			script := `. "$1"; . "$1"; printf '%s\n' "$PATH"`
			args := []string{"-c", script, "native-entry-test", rc}
			if item.name == "fish" {
				args = []string{"-c", `source $argv[1]; source $argv[1]; string join : $PATH`, rc}
			}
			cmd := exec.Command(shell, args...)
			cmd.Env = append(os.Environ(), "PATH=/usr/bin:/bin")
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("source: %v %s", err, out)
			}
			if got := strings.TrimSpace(string(out)); got != BinDir(home)+":/usr/bin:/bin" {
				t.Fatalf("sourced PATH %q", got)
			}
		})
	}
}

func TestConcurrentAdditiveInstallsAndPartialRemoval(t *testing.T) {
	home := t.TempDir()
	engines := []string{"codex", "claude", "grok"}
	start := make(chan struct{})
	failures := make(chan error, len(engines))
	var group sync.WaitGroup
	for _, engine := range engines {
		group.Add(1)
		go func(engine string) {
			defer group.Done()
			<-start
			failures <- Install(Options{home, "/usr/bin/cxx", []string{engine}})
		}(engine)
	}
	close(start)
	group.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, engine := range engines {
		if !IsManagedShim(filepath.Join(BinDir(home), engine)) {
			t.Fatalf("concurrent install lost %s", engine)
		}
	}
	for _, relative := range shellFiles {
		body, err := os.ReadFile(filepath.Join(home, relative))
		if err != nil || strings.Count(string(body), blockStart) != 1 {
			t.Fatalf("concurrent shell rewrite: %s %v", body, err)
		}
	}
	start = make(chan struct{})
	failures = make(chan error, 2)
	group.Add(2)
	go func() {
		defer group.Done()
		<-start
		failures <- Remove(Options{Home: home, Engines: []string{"codex"}})
	}()
	go func() {
		defer group.Done()
		<-start
		failures <- Install(Options{home, "/usr/bin/cxx", []string{"grok"}})
	}()
	close(start)
	group.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	if IsManagedShim(filepath.Join(BinDir(home), "codex")) {
		t.Fatal("partial removal lost")
	}
	for _, engine := range []string{"claude", "grok"} {
		if !IsManagedShim(filepath.Join(BinDir(home), engine)) {
			t.Fatal("partial removal erased peer")
		}
	}
	body, _ := os.ReadFile(filepath.Join(home, ".bashrc"))
	if strings.Count(string(body), blockStart) != 1 {
		t.Fatal("partial removal erased or duplicated PATH")
	}
}

func TestEntryLockFailureRequestsRetryWithoutMutation(t *testing.T) {
	home := t.TempDir()
	lock, err := layout.AcquireForTarget(context.Background(), BinDir(home))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	err = Install(Options{home, "/usr/bin/cxx", []string{"codex"}})
	if err == nil || !strings.Contains(err.Error(), "retry") {
		t.Fatalf("lock failure %v", err)
	}
	if _, err := os.Stat(BinDir(home)); !os.IsNotExist(err) {
		t.Fatal("mutation before lock acquisition")
	}
}

func TestResolveVendorPreservesClaudeCodeFallback(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude-code")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	got, err := ResolveVendor("claude-code", "/other/cxx")
	if err != nil || got != path {
		t.Fatalf("vendor fallback = %q, %v", got, err)
	}
}

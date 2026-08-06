package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestBareCXXRequiresEngine(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := run("cxx", nil, &stdout, &stderr); got != 2 {
		t.Fatalf("exit = %d, want 2", got)
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "cxx codex") || !strings.Contains(stderr.String(), "cxx claude") {
		t.Fatalf("unexpected output: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestGlobalVersionUsesCommonIdentity(t *testing.T) {
	oldVersion, oldCommit, oldDate := Version, Commit, BuildDate
	t.Cleanup(func() { Version, Commit, BuildDate = oldVersion, oldCommit, oldDate })
	Version, Commit, BuildDate = "1.2.3", "abc123", "2026-07-29T00:00:00Z"

	var stdout, stderr bytes.Buffer
	if got := run("cxx", []string{"--version"}, &stdout, &stderr); got != 0 {
		t.Fatalf("exit = %d, stderr=%q", got, stderr.String())
	}
	if !strings.Contains(stdout.String(), "cxx 1.2.3 (commit abc123") {
		t.Fatalf("version output = %q", stdout.String())
	}
}

func TestAliasesAndExplicitSelectorsKeepPersonaIdentity(t *testing.T) {
	tests := []struct {
		name      string
		invokedAs string
		args      []string
		want      string
	}{
		{"cdx alias", "/usr/local/bin/cdx", []string{"--wrapper-version"}, "cdx "},
		{"clx alias", "/usr/local/bin/clx", []string{"--wrapper-version"}, "clx "},
		{"versioned cdx alias", "/usr/local/bin/cdx-0.7.2", []string{"--wrapper-version"}, "cdx "},
		{"versioned clx alias", "/usr/local/bin/clx-0.7.2", []string{"--wrapper-version"}, "clx "},
		{"explicit codex", "cxx", []string{"codex", "--wrapper-version"}, "cdx "},
		{"explicit claude", "cxx", []string{"claude", "--wrapper-version"}, "clx "},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if got := run(tt.invokedAs, tt.args, &stdout, &stderr); got != 0 {
				t.Fatalf("exit = %d, stderr=%q", got, stderr.String())
			}
			if !strings.HasPrefix(stdout.String(), tt.want) {
				t.Fatalf("output = %q, want prefix %q", stdout.String(), tt.want)
			}
		})
	}
}

func TestVersionedAliasesRequireSemanticVersion(t *testing.T) {
	tests := []string{"cdx-debug", "clx-nightly", "cdx-0.7", "clx-0.7.2-rc.1"}
	for _, invokedAs := range tests {
		t.Run(invokedAs, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if got := run(invokedAs, nil, &stdout, &stderr); got != 2 {
				t.Fatalf("exit = %d, want 2; stderr=%q", got, stderr.String())
			}
			if !strings.Contains(stderr.String(), "cannot select an engine") {
				t.Fatalf("stderr = %q", stderr.String())
			}
		})
	}
}

func TestUnknownSelectorFailsClosed(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := run("cxx", []string{"gemini"}, &stdout, &stderr); got != 2 {
		t.Fatalf("exit = %d, want 2", got)
	}
	if !strings.Contains(stderr.String(), `unknown engine or global command "gemini"`) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

// TestHostSyncRunsEveryInstalledEngineAndReportsWorstExit: `cxx update` and
// `cxx sync` must converge a dual-engine host completely, and a broken engine
// must not be able to hide behind a healthy one.
func TestHostSyncRunsEveryInstalledEngineAndReportsWorstExit(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	base := filepath.Join(dir, "codex-orchestrator")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"cdx.json", "clx.json"} {
		if err := os.WriteFile(filepath.Join(base, name), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	var codexArgs, claudeArgs []string
	codexRun := func(args []string, _, _ io.Writer) int {
		codexArgs = args
		return 0
	}
	claudeRun := func(args []string, _, _ io.Writer) int {
		claudeArgs = args
		return 1
	}

	var stdout, stderr bytes.Buffer
	if got := syncEngines([]string{"--minimal"}, &stdout, &stderr, codexRun, claudeRun); got != 1 {
		t.Fatalf("exit = %d, want the worst engine exit (1)", got)
	}
	wantCodex := []string{"--config", filepath.Join(base, "cdx.json"), "sync", "--minimal"}
	if !reflect.DeepEqual(codexArgs, wantCodex) {
		t.Fatalf("codex argv = %v, want %v", codexArgs, wantCodex)
	}
	wantClaude := []string{"--config", filepath.Join(base, "clx.json"), "sync", "--minimal"}
	if !reflect.DeepEqual(claudeArgs, wantClaude) {
		t.Fatalf("claude argv = %v, want %v", claudeArgs, wantClaude)
	}
}

// TestHostSyncWithoutAnyInstalledEngineFails: silence here would look like a
// successful sync on a host that has nothing installed.
func TestHostSyncWithoutAnyInstalledEngineFails(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("CDX_CONFIG_PATH", "")
	t.Setenv("CLX_CONFIG_PATH", "")
	unreachable := func([]string, io.Writer, io.Writer) int {
		t.Fatal("persona was run without an installed config")
		return 0
	}
	var stdout, stderr bytes.Buffer
	if got := syncEngines(nil, &stdout, &stderr, unreachable, unreachable); got != 1 {
		t.Fatalf("exit = %d, want 1", got)
	}
	if !strings.Contains(stderr.String(), "no installed engine config found") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestHostSyncRejectsUnknownArguments(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := runHostSync([]string{"--nope"}, &stdout, &stderr); got != 2 {
		t.Fatalf("exit = %d, want 2", got)
	}
	if !strings.Contains(stderr.String(), "unknown argument") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestSelectorHelpAdvertisesSync(t *testing.T) {
	var out bytes.Buffer
	printSelectorHelp(&out)
	if !strings.Contains(out.String(), "cxx sync") {
		t.Fatalf("help does not mention cxx sync: %q", out.String())
	}
}

// TestHostSyncAcceptsThePostUpdateArgv closes the loop between the two halves of
// `cxx update`: whatever postUpdateSyncArgv emits in host mode is the argv the
// re-exec lands on, and `cxx sync` has to accept every token of it. A rejected
// flag here means the new binary is installed and the content never syncs.
func TestHostSyncAcceptsThePostUpdateArgv(t *testing.T) {
	for _, argv := range [][]string{
		{},
		{"--minimal"},
		{"--silent"},
		{"--skip-boot"},
		{"--minimal", "--silent", "--skip-boot"},
	} {
		var stdout, stderr bytes.Buffer
		t.Setenv("XDG_CONFIG_HOME", t.TempDir())
		t.Setenv("CDX_CONFIG_PATH", "")
		t.Setenv("CLX_CONFIG_PATH", "")
		// No engine is installed here, so exit 1 is the expected "nothing to do"
		// answer; exit 2 would mean argument rejection, which is the bug.
		if got := runHostSync(argv, &stdout, &stderr); got == 2 {
			t.Fatalf("cxx sync rejected post-update argv %v: %q", argv, stderr.String())
		}
	}
}

package main

import (
	"bytes"
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

func TestUnknownSelectorFailsClosed(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := run("cxx", []string{"gemini"}, &stdout, &stderr); got != 2 {
		t.Fatalf("exit = %d, want 2", got)
	}
	if !strings.Contains(stderr.String(), `unknown engine or global command "gemini"`) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

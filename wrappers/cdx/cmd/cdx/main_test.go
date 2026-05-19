package main

import (
	"bytes"
	"strings"
	"testing"
)

// TestIsHelpPassthrough covers the legacy contract from
// fe70ac3:docs/interface-cdx.md §"Help passthrough":
//
//   - top-level `--help` / `-h` / `help`
//   - reserved-subcommand followed by `--help` or `-h`
//   - everything else (including non-reserved subcommand + --help) stays
//     inside the wrapper so flag parsing can run normally.
func TestIsHelpPassthrough(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want bool
	}{
		{"empty argv", nil, false},
		{"top-level --help", []string{"--help"}, true},
		{"top-level -h", []string{"-h"}, true},
		{"bare help", []string{"help"}, true},
		{"reserved exec --help", []string{"exec", "--help"}, true},
		{"reserved exec -h", []string{"exec", "-h"}, true},
		{"reserved mcp-server --help", []string{"mcp-server", "--help"}, true},
		{"reserved app-server --help", []string{"app-server", "--help"}, true},
		{"reserved login --help", []string{"login", "--help"}, true},
		{"reserved logout --help", []string{"logout", "--help"}, true},
		{"reserved completion --help", []string{"completion", "--help"}, true},
		{"reserved sandbox --help", []string{"sandbox", "--help"}, true},
		{"reserved debug --help", []string{"debug", "--help"}, true},
		{"reserved apply --help", []string{"apply", "--help"}, true},
		{"reserved resume --help", []string{"resume", "--help"}, true},
		{"reserved fork --help", []string{"fork", "--help"}, true},
		{"reserved cloud --help", []string{"cloud", "--help"}, true},
		{"reserved features --help", []string{"features", "--help"}, true},
		{"reserved review --help", []string{"review", "--help"}, true},
		{"reserved mcp --help", []string{"mcp", "--help"}, true},
		{"reserved help itself", []string{"help"}, true},
		{"--help with flags before", []string{"--debug", "--help"}, true},
		// Non-reserved subcommand with --help stays inside the wrapper so
		// profile/lane shorthand can opt out of the upstream passthrough.
		{"profile shorthand + --help", []string{"myprofile", "--help"}, false},
		{"random subcommand + --help", []string{"deploy", "--help"}, false},
		// Sentinel `--` cuts off the search.
		{"--help after --", []string{"--", "--help"}, false},
		{"normal run", []string{"--debug"}, false},
		{"version flag", []string{"--version"}, false},
		{"cron action", []string{"--cron", "run"}, false},
		{"execute prompt", []string{"--execute", "hello"}, false},
		// Long-form help help — both trigger.
		{"help with extra args", []string{"help", "exec"}, true},
		// Top-level help with extra trailing args.
		{"--help with trailing positional", []string{"--help", "stuff"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isHelpPassthrough(tc.argv); got != tc.want {
				t.Errorf("isHelpPassthrough(%v) = %v, want %v", tc.argv, got, tc.want)
			}
		})
	}
}

func TestParseFlagsHelpShortCircuits(t *testing.T) {
	// When help passthrough fires, parseFlags must return only the
	// helpPassthrough sentinel — no positional/passthrough splitting that
	// could swallow flags meant for upstream codex.
	f, pos, pass := parseFlags([]string{"exec", "--help", "--profile", "x"})
	if !f.helpPassthrough {
		t.Fatalf("expected helpPassthrough=true")
	}
	if len(pos) != 0 || len(pass) != 0 {
		t.Errorf("expected empty positional/passthrough, got pos=%v pass=%v", pos, pass)
	}
}

func TestParseFlagsNonHelpStillParses(t *testing.T) {
	f, pos, pass := parseFlags([]string{"--debug", "exec", "--", "--unknown"})
	if f.helpPassthrough {
		t.Fatalf("did not expect helpPassthrough")
	}
	if !f.debug {
		t.Errorf("debug flag not set")
	}
	if len(pos) != 1 || pos[0] != "exec" {
		t.Errorf("positional = %v", pos)
	}
	if len(pass) != 1 || pass[0] != "--unknown" {
		t.Errorf("passthrough = %v", pass)
	}
}

// TestRunRefusesAfterMaxRestartDepth verifies the cdx run() entrypoint
// short-circuits with a non-zero exit when
// CODEX_WRAPPER_RESTART_DEPTH > maxRestartDepth — preventing a self-update
// feedback loop from looping forever on a broken host.
func TestRunRefusesAfterMaxRestartDepth(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTART_DEPTH", "5")
	var stdout, stderr bytes.Buffer
	code := run([]string{"--version"}, &stdout, &stderr)
	if code == 0 {
		t.Fatalf("expected non-zero exit; got %d (stderr=%q)", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "restart depth") {
		t.Errorf("missing restart-depth message: %q", stderr.String())
	}
}

// TestRunAcceptsDepthAtCap verifies depth == maxRestartDepth is still
// allowed (the cap is exclusive — guard fires when depth > cap).
func TestRunAcceptsDepthAtCap(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTART_DEPTH", "2")
	var stdout, stderr bytes.Buffer
	code := run([]string{"--version"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("expected version flag to succeed; got code=%d stderr=%q", code, stderr.String())
	}
}

// TestRunSnapshotsArgv verifies the package var update.SnapshottedArgv
// reflects argv at process entry, before parseFlags touches anything.
func TestRunSnapshotsArgv(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTART_DEPTH", "")
	var stdout, stderr bytes.Buffer
	args := []string{"--version", "--debug"}
	_ = run(args, &stdout, &stderr)
	got := snapshottedArgvForTest()
	if len(got) != len(args) {
		t.Fatalf("snapshot len=%d want %d (%v)", len(got), len(args), got)
	}
	for i := range args {
		if got[i] != args[i] {
			t.Errorf("snapshot[%d]=%q want %q", i, got[i], args[i])
		}
	}
}

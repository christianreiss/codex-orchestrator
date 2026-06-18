package main

import (
	"bytes"
	"strings"
	"testing"
)

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
		{"reserved mcp --help", []string{"mcp", "--help"}, true},
		{"reserved auth --help", []string{"auth", "--help"}, true},
		{"reserved config --help", []string{"config", "--help"}, true},
		{"reserved doctor --help", []string{"doctor", "--help"}, true},
		{"reserved login --help", []string{"login", "--help"}, true},
		{"reserved logout --help", []string{"logout", "--help"}, true},
		{"reserved sessions --help", []string{"sessions", "--help"}, true},
		{"reserved resume --help", []string{"resume", "--help"}, true},
		{"reserved help itself", []string{"help"}, true},
		{"--help with flags before", []string{"--debug", "--help"}, true},
		{"random subcommand + --help", []string{"deploy", "--help"}, false},
		{"--help after --", []string{"--", "--help"}, false},
		{"normal run", []string{"--debug"}, false},
		{"version flag", []string{"--version"}, false},
		{"continue flag", []string{"--continue"}, false},
		{"resume with session", []string{"--resume", "abc123"}, false},
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
	f, pos, pass := parseFlags([]string{"mcp", "--help"})
	if !f.helpPassthrough {
		t.Fatalf("expected helpPassthrough=true")
	}
	if len(pos) != 0 || len(pass) != 0 {
		t.Errorf("expected empty positional/passthrough, got pos=%v pass=%v", pos, pass)
	}
}

func TestParseFlagsContinueIsForwarded(t *testing.T) {
	f, _, pass := parseFlags([]string{"--continue"})
	if !f.continueSession {
		t.Fatalf("continueSession not set")
	}
	if len(pass) != 1 || pass[0] != "--continue" {
		t.Errorf("passthrough = %v", pass)
	}
}

func TestParseFlagsResumeIsForwarded(t *testing.T) {
	f, _, pass := parseFlags([]string{"--resume", "session-7"})
	if f.resumeSession != "session-7" {
		t.Errorf("resumeSession = %q", f.resumeSession)
	}
	if len(pass) != 2 || pass[0] != "--resume" || pass[1] != "session-7" {
		t.Errorf("passthrough = %v", pass)
	}
}

func TestParseFlagsResumeEqualForm(t *testing.T) {
	f, _, pass := parseFlags([]string{"--resume=session-9"})
	if f.resumeSession != "session-9" {
		t.Errorf("resumeSession = %q", f.resumeSession)
	}
	if len(pass) != 1 || pass[0] != "--resume=session-9" {
		t.Errorf("passthrough = %v", pass)
	}
}

func TestRunRefusesAfterMaxRestartDepth(t *testing.T) {
	t.Setenv("CLAUDE_WRAPPER_RESTART_DEPTH", "5")
	var stdout, stderr bytes.Buffer
	code := run([]string{"--version"}, &stdout, &stderr)
	if code == 0 {
		t.Fatalf("expected non-zero exit; got %d (stderr=%q)", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "restart depth") {
		t.Errorf("missing restart-depth message: %q", stderr.String())
	}
}

func TestRunAcceptsDepthAtCap(t *testing.T) {
	t.Setenv("CLAUDE_WRAPPER_RESTART_DEPTH", "2")
	var stdout, stderr bytes.Buffer
	code := run([]string{"--version"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("expected version flag to succeed; got code=%d stderr=%q", code, stderr.String())
	}
}

func TestRunSnapshotsArgv(t *testing.T) {
	t.Setenv("CLAUDE_WRAPPER_RESTART_DEPTH", "")
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

func TestValidateWrapperUpdateArtifactRefusesDowngrade(t *testing.T) {
	artifact := wrapperUpdateArtifact{Version: "0.6.15", URL: "https://example.invalid/clx", SHA256: strings.Repeat("a", 64)}
	if _, err := validateWrapperUpdateArtifact(artifact, "0.6.22"); err == nil {
		t.Fatal("expected downgrade refusal")
	} else if !strings.Contains(err.Error(), "refusing to downgrade") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateWrapperUpdateArtifactAllowsUpgrade(t *testing.T) {
	artifact := wrapperUpdateArtifact{Version: "0.6.23", URL: "https://example.invalid/clx", SHA256: strings.Repeat("a", 64)}
	got, err := validateWrapperUpdateArtifact(artifact, "0.6.22")
	if err != nil {
		t.Fatalf("validate upgrade: %v", err)
	}
	if got.Version != "0.6.23" {
		t.Fatalf("version = %q", got.Version)
	}
}

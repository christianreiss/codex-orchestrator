package main

import (
	"bytes"
	"reflect"
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
		// `sessions` is no longer reserved — claude has no such subcommand, so
		// it now behaves like any other unknown token.
		{"unreserved sessions --help", []string{"sessions", "--help"}, false},
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

func TestHelpExecArgv(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want []string
	}{
		{"bare help rewritten", []string{"help"}, []string{"--help"}},
		{"help with trailing token", []string{"help", "mcp"}, []string{"--help", "mcp"}},
		{"top-level --help untouched", []string{"--help"}, []string{"--help"}},
		{"short -h untouched", []string{"-h"}, []string{"-h"}},
		{"subcommand help untouched", []string{"mcp", "--help"}, []string{"mcp", "--help"}},
		{"flags before help still rewritten", []string{"--debug", "help"}, []string{"--debug", "--help"}},
		{"help after -- untouched", []string{"--", "help"}, []string{"--", "help"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := helpExecArgv(tc.argv)
			if strings.Join(got, " ") != strings.Join(tc.want, " ") {
				t.Errorf("helpExecArgv(%v) = %v, want %v", tc.argv, got, tc.want)
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

func TestParseFlagsDangerouslySkipPermissionsIsForwarded(t *testing.T) {
	f, pos, pass := parseFlags([]string{"--dangerously-skip-permissions"})
	if !f.dangerouslySkipPermissions {
		t.Fatalf("dangerouslySkipPermissions not set")
	}
	if len(pos) != 0 {
		t.Errorf("positional = %v", pos)
	}
	if len(pass) != 1 || pass[0] != "--dangerously-skip-permissions" {
		t.Errorf("passthrough = %v", pass)
	}
}

func TestParseFlagsDangerouslySkipPermissionsCombinesWithOtherFlags(t *testing.T) {
	f, pos, pass := parseFlags([]string{"--dangerously-skip-permissions", "--continue"})
	if !f.dangerouslySkipPermissions || !f.continueSession {
		t.Fatalf("expected both flags set, got %+v", f)
	}
	if len(pos) != 0 {
		t.Errorf("positional = %v", pos)
	}
	if len(pass) != 2 || pass[0] != "--dangerously-skip-permissions" || pass[1] != "--continue" {
		t.Errorf("passthrough = %v", pass)
	}
}

const testSession = "d9647178-2855-42b5-afaf-07caef131f73"

// TestParseFlagsResumeIsNotForwarded pins the inverted contract: --resume is
// normalised onto the wrapper's `resume` subcommand instead of being pushed to
// passthrough, so all three spellings (`resume`, `--resume`, `-r`) converge on
// one upstream argv via resumeArgs.
func TestParseFlagsResumeIsNotForwarded(t *testing.T) {
	f, pos, pass := parseFlags([]string{"--resume", testSession})
	if !f.resumeFlag {
		t.Errorf("resumeFlag = false, want true")
	}
	if f.resumeSession != testSession {
		t.Errorf("resumeSession = %q", f.resumeSession)
	}
	if len(pos) != 0 {
		t.Errorf("positional = %v", pos)
	}
	if len(pass) != 0 {
		t.Errorf("passthrough = %v, want empty (normalised via resumeArgs)", pass)
	}
}

func TestParseFlagsResumeEqualForm(t *testing.T) {
	f, pos, pass := parseFlags([]string{"--resume=" + testSession})
	if !f.resumeFlag {
		t.Errorf("resumeFlag = false, want true")
	}
	if f.resumeSession != testSession {
		t.Errorf("resumeSession = %q", f.resumeSession)
	}
	if len(pos) != 0 {
		t.Errorf("positional = %v", pos)
	}
	if len(pass) != 0 {
		t.Errorf("passthrough = %v, want empty (normalised via resumeArgs)", pass)
	}
}

// TestParseFlagsResumeShortForm covers `-r`, which previously died with
// "clx: unknown subcommand: -r" because parseFlags never recognised it.
func TestParseFlagsResumeShortForm(t *testing.T) {
	f, pos, _ := parseFlags([]string{"-r", testSession})
	if !f.resumeFlag {
		t.Errorf("resumeFlag = false, want true")
	}
	if f.resumeSession != testSession {
		t.Errorf("resumeSession = %q", f.resumeSession)
	}
	if len(pos) != 0 {
		t.Errorf("positional = %v, want empty (-r must not land as a subcommand)", pos)
	}
}

// TestParseFlagsBareResumeRequestsPicker covers `clx --resume` with no value:
// resumeSession is empty but the request is still real, which is why resumeFlag
// exists as a separate field.
func TestParseFlagsBareResumeRequestsPicker(t *testing.T) {
	f, _, pass := parseFlags([]string{"-r"})
	if !f.resumeFlag {
		t.Errorf("resumeFlag = false, want true")
	}
	if f.resumeSession != "" {
		t.Errorf("resumeSession = %q, want empty", f.resumeSession)
	}
	if len(pass) != 0 {
		t.Errorf("passthrough = %v, want empty", pass)
	}
}

// TestResumeArgs pins the upstream argv translation. The critical invariant is
// that a bare `resume` positional never reaches claude — it has no such
// subcommand and swallows the token as a prompt, opening a brand-new session.
func TestResumeArgs(t *testing.T) {
	tests := []struct {
		name string
		rest []string
		pass []string
		want []string
	}{
		{"bare picker", nil, nil, []string{"--resume"}},
		{"session id", []string{testSession}, nil, []string{"--resume", testSession}},
		{
			"session id + trailing prompt",
			[]string{testSession, "keep going"}, nil,
			[]string{"--resume", testSession, "keep going"},
		},
		{
			// --resume's value is optional upstream, so a leading flag parses
			// as picker + flag. No guard needed.
			"leading flag stays a flag",
			[]string{"--fork-session"}, nil,
			[]string{"--resume", "--fork-session"},
		},
		{"passthrough tail", []string{testSession}, []string{"--foo"}, []string{"--resume", testSession, "--foo"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := resumeArgs(tc.rest, tc.pass)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("resumeArgs(%v, %v) = %v, want %v", tc.rest, tc.pass, got, tc.want)
			}
			for _, a := range got {
				if a == "resume" {
					t.Errorf("argv %v contains bare `resume`; claude would treat it as a prompt", got)
				}
			}
		})
	}
}

// TestResumeDispatchPreservesTrailingPrompt guards the slicing trap — see the
// equivalent test in the cdx wrapper.
func TestResumeDispatchPreservesTrailingPrompt(t *testing.T) {
	f, positional, passthrough := parseFlags([]string{"-r", testSession, "keep going"})
	if !f.resumeFlag {
		t.Fatalf("resumeFlag = false, want true")
	}
	subArgs := positional
	if f.resumeSession != "" {
		subArgs = append([]string{f.resumeSession}, subArgs...)
	}
	got := resumeArgs(subArgs, passthrough)
	want := []string{"--resume", testSession, "keep going"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("flag-form resume argv = %v, want %v", got, want)
	}
}

// TestSessionsNotReserved locks in the removal of the stale `sessions`
// reservation: claude has no such subcommand, so forwarding it hung the wrapper
// on a literal "sessions" prompt. Unknown-subcommand is the correct answer.
func TestSessionsNotReserved(t *testing.T) {
	if reservedClaudeSubcommands["sessions"] {
		t.Errorf("sessions must not be reserved; claude has no such subcommand")
	}
	if !reservedClaudeSubcommands["resume"] {
		t.Errorf("resume must stay reserved so `clx resume --help` renders upstream help")
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

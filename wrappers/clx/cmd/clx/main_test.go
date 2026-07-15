package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
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

func TestWrapperHelpIsLocalAndNeedsNoConfig(t *testing.T) {
	t.Setenv("CLAUDE_WRAPPER_RESTART_DEPTH", "")
	var stdout, stderr bytes.Buffer
	code := run([]string{"--wrapper-help", "--config", filepath.Join(t.TempDir(), "missing.json")}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("wrapper help exit = %d, stderr=%q", code, stderr.String())
	}
	for _, want := range []string{"CLX WRAPPER HELP", "clx status", "--help opens Claude help"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("wrapper help missing %q:\n%s", want, stdout.String())
		}
	}
	if stderr.Len() != 0 {
		t.Fatalf("wrapper help stderr = %q", stderr.String())
	}
}

func TestWrapperHelpAfterSentinelIsPassedThrough(t *testing.T) {
	f, positional, passthrough := parseFlags([]string{"exec", "--", "--wrapper-help"})
	if f.wrapperHelp || !reflect.DeepEqual(positional, []string{"exec"}) || !reflect.DeepEqual(passthrough, []string{"--wrapper-help"}) {
		t.Fatalf("sentinel passthrough was hijacked: f=%+v positional=%v passthrough=%v", f, positional, passthrough)
	}
}

func TestWrapperHelpTokenCanBeExecutePrompt(t *testing.T) {
	f, positional, passthrough := parseFlags([]string{"--execute", "--wrapper-help"})
	if f.wrapperHelp || f.executePrompt != "--wrapper-help" || len(positional) != 0 || len(passthrough) != 0 {
		t.Fatalf("execute prompt was hijacked by help: f=%+v positional=%v passthrough=%v", f, positional, passthrough)
	}
}

func TestConflictingWrapperActionsFailBeforeMutation(t *testing.T) {
	t.Setenv("CLAUDE_WRAPPER_RESTART_DEPTH", "")
	for _, args := range [][]string{
		{"--uninstall", "--status"},
		{"status", "--uninstall"},
		{"--continue", "--status"},
		{"--continue", "--resume"},
	} {
		var stdout, stderr bytes.Buffer
		if code := run(args, &stdout, &stderr); code != 2 {
			t.Fatalf("conflicting actions %v exit = %d, want 2", args, code)
		}
		if !strings.Contains(stderr.String(), "conflicting wrapper actions") {
			t.Fatalf("missing conflict error for %v: %q", args, stderr.String())
		}
	}
}

func TestStatusAppliesReturnedCanonicalAuth(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 2.1.175\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"outdated","auth":{"last_refresh":"2026-07-15T12:00:00Z","claudeAiOauth":{"accessToken":"fresh"}},"host":{"fqdn":"status.test","secure":true},"versions":{"client_version":"2.1.175","wrapper_version":"0.6.44","runner_state":"ok"}}`))
	}))
	defer server.Close()
	cfg := &config.Config{
		Host:         config.Host{Secure: true},
		Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"},
	}
	var stdout, stderr bytes.Buffer
	if code := cmdStatus(context.Background(), cfg, "0.6.44", &stdout, &stderr, false); code != 0 {
		t.Fatalf("status exit = %d, stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil || !strings.Contains(string(raw), `"accessToken":"fresh"`) {
		t.Fatalf("canonical auth not written: raw=%q err=%v", raw, err)
	}
	if !strings.Contains(stdout.String(), "auth=updated") {
		t.Fatalf("status did not report applied auth: %q", stdout.String())
	}
	stdout.Reset()
	stderr.Reset()
	if code := cmdStatus(context.Background(), cfg, "0.6.44", &stdout, &stderr, false); code != 0 {
		t.Fatalf("second status exit = %d, stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), "auth=ok") || strings.Contains(stdout.String(), "auth=updated") || strings.Contains(stdout.String(), "auth=warn") {
		t.Fatalf("equivalent OAuth credentials did not settle to current: %q", stdout.String())
	}
}

func TestStatusCanonicalAuthNeverClobbersFresherLocal(t *testing.T) {
	local := filepath.Join(t.TempDir(), ".credentials.json")
	if err := os.WriteFile(local, []byte(`{"last_refresh":"2026-07-15T12:00:00Z","claudeAiOauth":{"accessToken":"local"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	older := []byte(`{"last_refresh":"2026-07-15T11:00:00Z","claudeAiOauth":{"accessToken":"fleet"}}`)
	newer := []byte(`{"last_refresh":"2026-07-15T13:00:00Z","claudeAiOauth":{"accessToken":"fleet"}}`)
	if statusCanonicalAuthMayReplace(local, older) {
		t.Fatal("older canonical auth was allowed to replace the fresher local login")
	}
	if !statusCanonicalAuthMayReplace(local, newer) {
		t.Fatal("newer canonical auth was not allowed to repair the local file")
	}
	if statusCanonicalAuthMayReplace(local, []byte(`{"claudeAiOauth":{"accessToken":"unknown-age"}}`)) {
		t.Fatal("unstamped canonical auth was allowed to replace an existing local login")
	}
	if !statusCanonicalAuthMayReplace(filepath.Join(t.TempDir(), "missing.json"), older) {
		t.Fatal("canonical auth was not allowed to seed a missing local file")
	}
}

func TestStatusWithUnreadableConfigIsBlocked(t *testing.T) {
	t.Setenv("CLAUDE_WRAPPER_RESTART_DEPTH", "")
	var stdout, stderr bytes.Buffer
	code := run([]string{"--status", "--config", filepath.Join(t.TempDir(), "missing.json")}, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("status exit = %d, want 1; stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), "status=blocked") || !strings.Contains(stdout.String(), "config=unreadable") {
		t.Fatalf("status output is not actionable: %q", stdout.String())
	}
}

func TestExecuteDispatchPreservesTrailingArguments(t *testing.T) {
	f, positional, passthrough := parseFlags([]string{"--execute", "hello", "tail", "--", "--json"})
	sub, subArgs := resolveCommand(f, positional)
	if sub != "execute" || !reflect.DeepEqual(subArgs, []string{"tail"}) || !reflect.DeepEqual(passthrough, []string{"--json"}) {
		t.Fatalf("execute dispatch = %q args=%v passthrough=%v", sub, subArgs, passthrough)
	}
}

func TestBareResumeDoesNotConsumeFollowingFlags(t *testing.T) {
	f, positional, passthrough := parseFlags([]string{"-r", "-c"})
	if !f.resumeFlag || f.resumeSession != "" || !f.continueSession || len(positional) != 0 || !reflect.DeepEqual(passthrough, []string{"--continue"}) {
		t.Fatalf("bare resume parsing lost a flag: f=%+v positional=%v passthrough=%v", f, positional, passthrough)
	}
}

func TestRunRejectsMissingOrBlankExecutePrompt(t *testing.T) {
	t.Setenv("CLAUDE_WRAPPER_RESTART_DEPTH", "")
	for _, tc := range []struct {
		name string
		args []string
	}{
		{name: "missing", args: []string{"--execute"}},
		{name: "blank", args: []string{"--execute", " \t "}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if code := run(tc.args, &stdout, &stderr); code != 2 {
				t.Fatalf("run(%v) exit = %d, want 2", tc.args, code)
			}
			if got, want := stderr.String(), "clx: --execute requires a non-empty prompt argument\n"; got != want {
				t.Errorf("stderr = %q, want %q", got, want)
			}
			if stdout.Len() != 0 {
				t.Errorf("stdout = %q, want empty", stdout.String())
			}
		})
	}
}

func TestTopLevelParityAliasesDispatch(t *testing.T) {
	for _, tc := range []struct {
		name    string
		args    []string
		wantSub string
	}{
		{name: "status", args: []string{"--status"}, wantSub: "status"},
		{name: "doctor", args: []string{"--doctor"}, wantSub: "doctor"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, positional, passthrough := parseFlags(tc.args)
			sub, subArgs := resolveCommand(f, positional)
			if sub != tc.wantSub || len(subArgs) != 0 || len(passthrough) != 0 {
				t.Errorf("dispatch = %q args=%v passthrough=%v, want %q with no args", sub, subArgs, passthrough, tc.wantSub)
			}
		})
	}

	for _, arg := range []string{"-W", "--wrapper-version"} {
		f, positional, passthrough := parseFlags([]string{arg})
		if !f.versionFlag || len(positional) != 0 || len(passthrough) != 0 {
			t.Errorf("parseFlags(%q) = version=%t positional=%v passthrough=%v", arg, f.versionFlag, positional, passthrough)
		}
	}
}

func TestInvalidCronActionsReachStrictDispatch(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
	}{
		{name: "flag form", args: []string{"--cron", "bogus"}},
		{name: "subcommand form", args: []string{"cron", "bogus"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, positional, passthrough := parseFlags(tc.args)
			if len(passthrough) != 0 {
				t.Fatalf("passthrough = %v, want empty", passthrough)
			}
			sub, subArgs := resolveCommand(f, positional)
			if sub != "cron" || !reflect.DeepEqual(subArgs, []string{"bogus"}) {
				t.Fatalf("dispatch = %q %v, want cron [bogus]", sub, subArgs)
			}

			var stdout, stderr bytes.Buffer
			if code := cmdCron(context.Background(), nil, subArgs, &stdout, &stderr); code != 2 {
				t.Fatalf("cmdCron exit = %d, want 2", code)
			}
			if got, want := stderr.String(), "clx cron: unknown action: bogus\nusage: clx cron [install|remove|run]\n"; got != want {
				t.Errorf("stderr = %q, want %q", got, want)
			}
			if stdout.Len() != 0 {
				t.Errorf("stdout = %q, want empty", stdout.String())
			}
		})
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
	sub, subArgs := resolveCommand(f, positional)
	if sub != "resume" {
		t.Fatalf("subcommand = %q, want resume", sub)
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

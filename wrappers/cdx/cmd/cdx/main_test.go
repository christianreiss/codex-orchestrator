package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
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
		{"resume with session", []string{"--resume", "d9647178-2855-42b5-afaf-07caef131f73"}, false},
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

func TestWrapperHelpIsLocalAndNeedsNoConfig(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTART_DEPTH", "")
	var stdout, stderr bytes.Buffer
	code := run([]string{"--wrapper-help", "--config", filepath.Join(t.TempDir(), "missing.json")}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("wrapper help exit = %d, stderr=%q", code, stderr.String())
	}
	for _, want := range []string{"CDX WRAPPER HELP", "cdx status", "--help opens Codex help"} {
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
	t.Setenv("CODEX_WRAPPER_RESTART_DEPTH", "")
	for _, args := range [][]string{{"--uninstall", "--status"}, {"status", "--uninstall"}} {
		var stdout, stderr bytes.Buffer
		if code := run(args, &stdout, &stderr); code != 2 {
			t.Fatalf("conflicting actions %v exit = %d, want 2", args, code)
		}
		if !strings.Contains(stderr.String(), "conflicting wrapper actions") {
			t.Fatalf("missing conflict error for %v: %q", args, stderr.String())
		}
	}
}

func TestExplicitLaneSelectionPersists(t *testing.T) {
	var method, lane string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		lane = body["lane"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdLane(context.Background(), cfg, []string{"spark"}, &stdout, &stderr); code != 0 {
		t.Fatalf("lane exit = %d, stderr=%q", code, stderr.String())
	}
	if method != http.MethodPost || lane != "spark" || !strings.Contains(stdout.String(), "persisted") {
		t.Fatalf("lane was not persisted: method=%q lane=%q stdout=%q", method, lane, stdout.String())
	}
}

func TestLaneClearPostsNullPreference(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %q, want POST", r.Method)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdLane(context.Background(), cfg, []string{"clear"}, &stdout, &stderr); code != 0 {
		t.Fatalf("lane clear exit = %d, stderr=%q", code, stderr.String())
	}
	lane, present := body["lane"]
	if !present || lane != nil || !strings.Contains(stdout.String(), "inherited default") {
		t.Fatalf("lane clear body/output = body=%v stdout=%q", body, stdout.String())
	}
}

func TestLaneRejectsContradictorySelectorsBeforeRequest(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	for _, args := range [][]string{{"clear", "spark"}, {"normal", "spark"}} {
		var stdout, stderr bytes.Buffer
		if code := cmdLane(context.Background(), cfg, args, &stdout, &stderr); code != 2 {
			t.Fatalf("lane %v exit = %d, want 2", args, code)
		}
	}
	if requests != 0 {
		t.Fatalf("contradictory selectors made %d requests", requests)
	}
}

func TestStatusAppliesReturnedCanonicalAuth(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 0.144.1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"outdated","auth":{"last_refresh":"2026-07-15T12:00:00Z","tokens":{"access_token":"fresh"}},"host":{"fqdn":"status.test","secure":true},"versions":{"client_version":"0.144.1","wrapper_version":"0.6.44","runner_state":"ok"}}`))
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
	raw, err := os.ReadFile(filepath.Join(home, ".codex", "auth.json"))
	if err != nil || !strings.Contains(string(raw), `"access_token":"fresh"`) {
		t.Fatalf("canonical auth not written: raw=%q err=%v", raw, err)
	}
	if !strings.Contains(stdout.String(), "auth=updated") {
		t.Fatalf("status did not report applied auth: %q", stdout.String())
	}
}

func TestStatusCanonicalAuthNeverClobbersFresherLocal(t *testing.T) {
	local := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(local, []byte(`{"last_refresh":"2026-07-15T12:00:00Z","tokens":{"access_token":"local"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	older := []byte(`{"last_refresh":"2026-07-15T11:00:00Z","tokens":{"access_token":"fleet"}}`)
	newer := []byte(`{"last_refresh":"2026-07-15T13:00:00Z","tokens":{"access_token":"fleet"}}`)
	if statusCanonicalAuthMayReplace(local, older) {
		t.Fatal("older canonical auth was allowed to replace the fresher local login")
	}
	if !statusCanonicalAuthMayReplace(local, newer) {
		t.Fatal("newer canonical auth was not allowed to repair the local file")
	}
	if statusCanonicalAuthMayReplace(local, []byte(`{"tokens":{"access_token":"unknown-age"}}`)) {
		t.Fatal("unstamped canonical auth was allowed to replace an existing local login")
	}
	if !statusCanonicalAuthMayReplace(filepath.Join(t.TempDir(), "missing.json"), older) {
		t.Fatal("canonical auth was not allowed to seed a missing local file")
	}
}

func TestStatusWithUnreadableConfigIsBlocked(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTART_DEPTH", "")
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
	f, positional, passthrough := parseFlags([]string{"--resume", "--minimal"})
	if !f.resumeFlag || f.resumeSession != "" || !f.minimal || len(positional) != 0 || len(passthrough) != 0 {
		t.Fatalf("bare resume parsing lost a flag: f=%+v positional=%v passthrough=%v", f, positional, passthrough)
	}
}

func TestRunRejectsMissingOrBlankExecutePrompt(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTART_DEPTH", "")
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
			if got, want := stderr.String(), "cdx: --execute requires a non-empty prompt argument\n"; got != want {
				t.Errorf("stderr = %q, want %q", got, want)
			}
			if stdout.Len() != 0 {
				t.Errorf("stdout = %q, want empty", stdout.String())
			}
		})
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
			if got, want := stderr.String(), "cdx cron: unknown action: bogus\nusage: cdx cron [install|remove|run]\n"; got != want {
				t.Errorf("stderr = %q, want %q", got, want)
			}
			if stdout.Len() != 0 {
				t.Errorf("stdout = %q, want empty", stdout.String())
			}
		})
	}
}

const testSession = "d9647178-2855-42b5-afaf-07caef131f73"

// TestParseFlagsResumeIsNotForwarded pins the inverted contract: --resume must
// NOT reach passthrough. Upstream codex has no --resume flag and rejects it
// ("error: unexpected argument '--resume' found"), so the wrapper records the
// intent and re-spells it as the `resume` subcommand via resumeArgs.
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
		t.Errorf("passthrough = %v, want empty (codex rejects --resume)", pass)
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
		t.Errorf("passthrough = %v, want empty (codex rejects --resume)", pass)
	}
}

// TestParseFlagsBareResumeRequestsPicker covers `cdx --resume` with no value:
// resumeSession is empty but the request is still real, which is why resumeFlag
// exists as a separate field.
func TestParseFlagsBareResumeRequestsPicker(t *testing.T) {
	f, _, pass := parseFlags([]string{"--resume"})
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

// TestResumeArgs pins the upstream argv translation for every user-facing form.
// `rest` is what run() hands over after the flag/subcommand paths converge.
func TestResumeArgs(t *testing.T) {
	tests := []struct {
		name string
		rest []string
		pass []string
		want []string
	}{
		{"bare picker", nil, nil, []string{"resume"}},
		{"session id", []string{testSession}, nil, []string{"resume", testSession}},
		{"last", []string{"--last"}, nil, []string{"resume", "--last"}},
		{
			// codex resume [SESSION_ID] [PROMPT] — the trailing prompt is a
			// documented form and must survive both spellings.
			"session id + trailing prompt",
			[]string{testSession, "keep going"}, nil,
			[]string{"resume", testSession, "keep going"},
		},
		{"passthrough tail", []string{testSession}, []string{"--foo"}, []string{"resume", testSession, "--foo"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := resumeArgs(tc.rest, tc.pass)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("resumeArgs(%v, %v) = %v, want %v", tc.rest, tc.pass, got, tc.want)
			}
		})
	}
}

// TestResumeDispatchPreservesTrailingPrompt guards the slicing trap: run()'s
// preamble does sub = positional[0]; subArgs = positional[1:], which assumes
// positional[0] names a subcommand. When resume intent arrives via the *flag*,
// positional[0] is a real trailing prompt, so the flag path must rebind to the
// unsliced positional or the prompt is silently dropped.
func TestResumeDispatchPreservesTrailingPrompt(t *testing.T) {
	f, positional, passthrough := parseFlags([]string{"--resume", testSession, "keep going"})
	if !f.resumeFlag {
		t.Fatalf("resumeFlag = false, want true")
	}
	sub, subArgs := resolveCommand(f, positional)
	if sub != "resume" {
		t.Fatalf("subcommand = %q, want resume", sub)
	}
	got := resumeArgs(subArgs, passthrough)
	want := []string{"resume", testSession, "keep going"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("flag-form resume argv = %v, want %v", got, want)
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

// TestReservedSubcommandsCoverPassthrough guards the passthrough fallback in
// the run() switch: each reserved Codex subcommand must be claimed (so
// `cdx resume`, `cdx login`, etc. don't fall into the "unknown subcommand"
// default). Either an explicit wrapper case owns it (`exec`) or the default
// branch forwards it to the upstream binary via reservedCodexSubcommands[sub].
func TestReservedSubcommandsCoverPassthrough(t *testing.T) {
	for sub := range reservedCodexSubcommands {
		if sub == "" {
			t.Errorf("empty key in reservedCodexSubcommands")
		}
	}
	// Sanity: resume is the one the user hit; lock it in explicitly.
	if !reservedCodexSubcommands["resume"] {
		t.Errorf("resume must be reserved so default-case passthrough fires")
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

func TestValidateWrapperUpdateArtifactRefusesDowngrade(t *testing.T) {
	artifact := wrapperUpdateArtifact{Version: "0.6.15", URL: "https://example.invalid/cdx", SHA256: strings.Repeat("a", 64)}
	if _, err := validateWrapperUpdateArtifact(artifact, "0.6.22"); err == nil {
		t.Fatal("expected downgrade refusal")
	} else if !strings.Contains(err.Error(), "refusing to downgrade") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateWrapperUpdateArtifactAllowsUpgrade(t *testing.T) {
	artifact := wrapperUpdateArtifact{Version: "0.6.23", URL: "https://example.invalid/cdx", SHA256: strings.Repeat("a", 64)}
	got, err := validateWrapperUpdateArtifact(artifact, "0.6.22")
	if err != nil {
		t.Fatalf("validate upgrade: %v", err)
	}
	if got.Version != "0.6.23" {
		t.Fatalf("version = %q", got.Version)
	}
}

// TestLoginRotatedAuth pins when a completed `cdx login` triggers the
// post-login credential upload: only a zero exit AND a changed, non-empty
// auth.json digest. `codex login status` (digest unchanged) and failed logins
// must not upload.
func TestLoginRotatedAuth(t *testing.T) {
	cases := []struct {
		name          string
		exit          int
		before, after string
		want          bool
	}{
		{"fresh login rotates", 0, "aaa", "bbb", true},
		{"first-ever login (no prior file)", 0, "", "bbb", true},
		{"login status leaves digest untouched", 0, "aaa", "aaa", false},
		{"failed login never uploads", 1, "aaa", "bbb", false},
		{"login removed the file", 0, "aaa", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := loginRotatedAuth(tc.exit, tc.before, tc.after); got != tc.want {
				t.Fatalf("loginRotatedAuth(%d, %q, %q) = %v, want %v", tc.exit, tc.before, tc.after, got, tc.want)
			}
		})
	}
}

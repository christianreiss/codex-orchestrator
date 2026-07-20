package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
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
		{"minimal stripped before help", []string{"--minimal", "help"}, []string{"--help"}},
		{"minimal stripped after subcommand", []string{"mcp", "--minimal-output", "--help"}, []string{"mcp", "--help"}},
		{"help after -- untouched", []string{"--", "help"}, []string{"--", "help"}},
		{"minimal after -- untouched", []string{"--help", "--", "--minimal"}, []string{"--help", "--", "--minimal"}},
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

func TestAuthMutationRoutingLeavesStatusReadOnly(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{args: []string{"login"}, want: "login"},
		{args: []string{"logout"}, want: "logout"},
		{args: []string{"auth", "login"}, want: "login"},
		{args: []string{"auth", "logout"}, want: "logout"},
		{args: []string{"auth", "status"}, want: ""},
		{args: []string{"auth"}, want: ""},
	} {
		if got := authMutationKind(tc.args); got != tc.want {
			t.Errorf("authMutationKind(%v) = %q, want %q", tc.args, got, tc.want)
		}
	}
	if commandOwnsAuthSession("auth", []string{"status"}) {
		t.Fatal("auth status was routed through the wrapper-owned mutation path")
	}
}

func TestHelpChildKeepsInsecurePurgeDeferredUntilItExits(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_WRAPPER_RESTART_DEPTH", "")
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"temporary"}}`)); err != nil {
		t.Fatal(err)
	}
	peer, err := claude.StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(home, "help-ready")
	release := filepath.Join(home, "help-release")
	t.Setenv("CLX_HELP_READY", ready)
	t.Setenv("CLX_HELP_RELEASE", release)
	bin := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(bin, []byte(`#!/bin/sh
: > "$CLX_HELP_READY"
while [ ! -e "$CLX_HELP_RELEASE" ]; do sleep 0.01; done
echo upstream-help
`), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
	t.Cleanup(func() { _ = os.WriteFile(release, nil, 0o600) })
	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() { done <- run([]string{"--help"}, &stdout, &stderr) }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("help child did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if purged, err := peer.CloseAndPurgeIfLast(); err != nil || purged {
		t.Fatalf("peer exit during help purged=%v err=%v", purged, err)
	}
	if !claude.HasUsableAuth() {
		t.Fatal("help child lost credentials while still running")
	}
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if code := <-done; code != 0 {
		t.Fatalf("help exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if claude.HasUsableAuth() {
		t.Fatal("help exit stranded the peer's insecure purge request")
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

func TestExplicitMinimalForcesPortableHelpAndUpdateOutput(t *testing.T) {
	rich := ui.Caps{
		IsTTY:   true,
		UTF8:    true,
		Columns: 120,
		Palette: ui.Palette{Bold: "\x1b[1m", Reset: "\x1b[0m", Cyan: "\x1b[96m", Green: "\x1b[32m", Red: "\x1b[31m"},
	}
	caps := commandCaps(rich, true)
	if caps.IsTTY || !caps.NoColor || !caps.Dumb || caps.UTF8 || caps.Palette != (ui.Palette{}) {
		t.Fatalf("minimal caps retained terminal features: %+v", caps)
	}

	var help bytes.Buffer
	ui.PrintWrapperHelp(&help, caps)
	assertPortableOutput(t, help.String())
	if !strings.Contains(help.String(), "CLX WRAPPER HELP") || strings.ContainsAny(help.String(), "╭╮╰╯│") {
		t.Fatalf("minimal help is not the plain renderer:\n%s", help.String())
	}

	updates := []string{
		ui.UpdateProgress(caps, "clx", "wrapper", "0.6.44", "0.6.45"),
		ui.UpdateComplete(caps, "clx", "wrapper", "0.6.45", false),
		ui.UpdateFailure(caps, "clx", "wrapper", "0.6.45", fmt.Errorf("checksum mismatch")),
	}
	for _, line := range updates {
		assertPortableOutput(t, line)
		if strings.ContainsAny(line, "↻✓✗→…") {
			t.Fatalf("minimal update retained rich glyphs: %q", line)
		}
	}

	var stdout, stderr bytes.Buffer
	if code := run([]string{"--minimal", "--wrapper-help", "--config", filepath.Join(t.TempDir(), "missing.json")}, &stdout, &stderr); code != 0 {
		t.Fatalf("minimal wrapper help exit = %d, stderr=%q", code, stderr.String())
	}
	assertPortableOutput(t, stdout.String())
}

func TestExecuteLifecycleOptionsPreserveMinimal(t *testing.T) {
	got := executeLifecycleOptions(flags{minimal: true, allowConc: true, dangerouslySkipPermissions: true})
	if !got.Minimal || !got.SkipBoot || !got.Headless || !got.AllowConcurrentSync || !got.DangerouslySkipPermissions {
		t.Fatalf("execute lifecycle options lost wrapper flags: %+v", got)
	}
}

func TestPrintLifecycleErrorIsPortable(t *testing.T) {
	var out bytes.Buffer
	printLifecycleError(&out, "clx run", fmt.Errorf("denied Ω\n\x1b[31mforged"))
	assertPortableOutput(t, out.String())
	if strings.Count(out.String(), "\n") != 1 {
		t.Fatalf("dynamic error forged extra rows: %q", out.String())
	}
}

func TestPrintBoundedPlainRedirectedUsesASCII(t *testing.T) {
	t.Setenv("COLUMNS", "24")
	var out bytes.Buffer
	printBoundedPlain(&out, "clx: "+strings.Repeat("long ", 20), false)
	if ui.VisibleWidth(strings.TrimSuffix(out.String(), "\n")) > 24 || strings.Contains(out.String(), "…") || !strings.Contains(out.String(), "...") {
		t.Fatalf("redirected bounded line is not portable: %q", out.String())
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

func TestInsecureStatusPurgesMaterializedAuthAfterCommand(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 2.1.175\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"outdated","auth":{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"temporary"}},"host":{"fqdn":"insecure.test","secure":false}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: false}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	code := withInsecureAuthSession(cfg, &stderr, func() int {
		return cmdStatus(context.Background(), cfg, "test", &stdout, &stderr, true)
	})
	if code != 0 {
		t.Fatalf("status code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", ".credentials.json")); !os.IsNotExist(err) {
		t.Fatalf("insecure status retained credentials: %v", err)
	}
}

func TestStatusCanonicalAuthNeverClobbersFresherLocal(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	local := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(filepath.Dir(local), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(local, []byte(`{"last_refresh":"2026-07-15T12:00:00Z","claudeAiOauth":{"accessToken":"local"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	snap, err := claude.ReadAuthForRetrieveSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	older := []byte(`{"last_refresh":"2026-07-15T11:00:00Z","claudeAiOauth":{"accessToken":"fleet"}}`)
	newer := []byte(`{"last_refresh":"2026-07-15T13:00:00Z","claudeAiOauth":{"accessToken":"fleet"}}`)
	if claude.ServerAuthMayReplace(snap, older, "", "verified", false) {
		t.Fatal("older canonical auth was allowed to replace the fresher local login")
	}
	if !claude.ServerAuthMayReplace(snap, newer, "", "verified", false) {
		t.Fatal("newer canonical auth was not allowed to repair the local file")
	}
	if claude.ServerAuthMayReplace(snap, []byte(`{"claudeAiOauth":{"accessToken":"unknown-age"}}`), "", "verified", false) {
		t.Fatal("unstamped canonical auth was allowed to replace an existing local login")
	}
	if !claude.ServerAuthMayReplace(claude.AuthSnapshot{}, older, "", "verified", false) {
		t.Fatal("canonical auth was not allowed to seed a missing local file")
	}
}

func TestStatusNeverWritesFailedVerificationCanonical(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	setStatusClaudeBin(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"outdated","verification_state":"failed","auth":{"last_refresh":"2026-07-17T13:00:00Z","claudeAiOauth":{"accessToken":"known-bad"}},"host":{"secure":true}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdStatus(context.Background(), cfg, "test", &stdout, &stderr, true); code != 1 {
		t.Fatalf("status code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", ".credentials.json")); !os.IsNotExist(err) {
		t.Fatalf("failed-verification canonical was materialized: %v", err)
	}
}

func TestStatusRepairsStructurallyInvalidNativeJSON(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	setStatusClaudeBin(t)
	authPath := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(authPath, []byte(`{broken-json`), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"outdated","verification_state":"verified","canonical_last_refresh":"2026-07-16T13:00:00Z","auth":{"last_refresh":"2026-07-16T13:00:00Z","claudeAiOauth":{"accessToken":"healed"}},"host":{"secure":true}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdStatus(context.Background(), cfg, "test", &stdout, &stderr, true); code != 0 {
		t.Fatalf("invalid-native status code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	raw, err := os.ReadFile(authPath)
	if err != nil || !strings.Contains(string(raw), `"accessToken":"healed"`) {
		t.Fatalf("status did not heal invalid native JSON: raw=%q err=%v", raw, err)
	}
}

func TestStatusMaterializesRequiredCanonicalWriteAlongsideActiveChild(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	ready := filepath.Join(home, "ready")
	release := filepath.Join(home, "release")
	t.Setenv("CLX_TEST_READY", ready)
	t.Setenv("CLX_TEST_RELEASE", release)
	bin := filepath.Join(t.TempDir(), "claude")
	script := `#!/bin/sh
if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then echo 2.1.175; exit 0; fi
: > "$CLX_TEST_READY"
while [ ! -e "$CLX_TEST_RELEASE" ]; do sleep 0.01; done
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
	childDone := make(chan error, 1)
	go func() {
		_, err := claude.Run(context.Background(), &config.Config{}, nil)
		childDone <- err
	}()
	t.Cleanup(func() { _ = os.WriteFile(release, nil, 0o600) })
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("peer Claude child did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"outdated","verification_state":"verified","canonical_last_refresh":"2026-07-17T13:00:00Z","auth":{"last_refresh":"2026-07-17T13:00:00Z","claudeAiOauth":{"accessToken":"needed"}},"host":{"secure":true}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdStatus(context.Background(), cfg, "test", &stdout, &stderr, true); code != 0 {
		t.Fatalf("active-child status code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if raw, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json")); err != nil || !bytes.Contains(raw, []byte("needed")) {
		t.Fatalf("canonical was not written under active child: %q %v", raw, err)
	}
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := <-childDone; err != nil {
		t.Fatal(err)
	}
}

func TestStatusReportsExplicitLogoutBeforeCanonicalEquality(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	setStatusClaudeBin(t)
	payload := json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"same"}}`)
	seedSameDigestLogoutIntent(t, payload)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"valid","verification_state":"verified","auth":{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"same"}},"host":{"secure":true}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdStatus(context.Background(), cfg, "test", &stdout, &stderr, true); code != 1 {
		t.Fatalf("logged-out status code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), "Explicitly logged out locally") {
		t.Fatalf("explicit logout was hidden by canonical equality: %q", stdout.String())
	}
	if !claude.HasLogoutIntent() {
		t.Fatal("status erased explicit logout intent")
	}
}

func TestStatusLogoutMarkerParseErrorIsNonzeroBeforeNetwork(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	marker := filepath.Join(home, ".clx", "auth", "logout-intent.json")
	if err := os.MkdirAll(filepath.Dir(marker), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte(`{broken`), 0o600); err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdStatus(context.Background(), cfg, "test", &stdout, &stderr, true); code != 1 {
		t.Fatalf("marker-error status code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if requests.Load() != 0 || !strings.Contains(stderr.String(), "logout intent") {
		t.Fatalf("marker error did not fail before network: requests=%d stderr=%q", requests.Load(), stderr.String())
	}
}

func TestStatusUsesAPIAuthoritativeSecurityForPurge(t *testing.T) {
	for _, tc := range []struct {
		name         string
		configSecure bool
		response     string
		wantAuth     bool
	}{
		{name: "API insecure overrides stale secure config", configSecure: true, response: `{"status":"valid","host":{"secure":false}}`, wantAuth: false},
		{name: "insecure status without host requests purge", configSecure: true, response: `{"status":"insecure"}`, wantAuth: false},
		{name: "API secure cancels this stale insecure config", configSecure: false, response: `{"status":"valid","host":{"secure":true}}`, wantAuth: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			setStatusClaudeBin(t)
			if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"temporary"}}`)); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.response))
			}))
			defer server.Close()
			cfg := &config.Config{Host: config.Host{Secure: tc.configSecure}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
			var stdout, stderr bytes.Buffer
			_ = cmdStatus(context.Background(), cfg, "test", &stdout, &stderr, true)
			gotAuth := claude.HasUsableAuth()
			if gotAuth != tc.wantAuth {
				t.Fatalf("auth present=%v want=%v stdout=%q stderr=%q", gotAuth, tc.wantAuth, stdout.String(), stderr.String())
			}
		})
	}
}

func TestAPISecureCancellationDoesNotErasePeerInsecurePurgeRequest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	setStatusClaudeBin(t)
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"temporary"}}`)); err != nil {
		t.Fatal(err)
	}
	peer, err := claude.StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"valid","host":{"secure":true}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: false}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdStatus(context.Background(), cfg, "test", &stdout, &stderr, true); code != 0 {
		t.Fatalf("status code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !claude.HasUsableAuth() {
		t.Fatal("status purged while peer insecure session remained active")
	}
	purged, err := peer.CloseAndPurgeIfLast()
	if err != nil || !purged {
		t.Fatalf("peer purge request was canceled: purged=%v err=%v", purged, err)
	}
}

func TestStandaloneAuthLoginUploadsAndAppliesAcceptedCredentials(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := filepath.Join(t.TempDir(), "claude")
	script := `#!/bin/sh
mkdir -p "$HOME/.claude"
printf '%s' '{"claudeAiOauth":{"accessToken":"standalone-login"}}' > "$HOME/.claude/.credentials.json"
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
	requestBody := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requestBody <- string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated","auth":{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"standalone-login"}}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := runClaudeAuthMutation(context.Background(), cfg, []string{"auth", "login"}, &stdout, &stderr); code != 0 {
		t.Fatalf("login code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	body := <-requestBody
	if !strings.Contains(body, "standalone-login") || !strings.Contains(body, "last_refresh") {
		t.Fatalf("standalone login was not uploaded canonically: %s", body)
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil || !strings.Contains(string(raw), "standalone-login") {
		t.Fatalf("accepted auth not materialized: raw=%q err=%v", raw, err)
	}
}

func TestExplicitAuthUploadConvergesCanonicalWinButDoesNotClaimAcceptance(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T08:00:00Z","claudeAiOauth":{"accessToken":"client-older"}}`)); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"status":"outdated","verification_state":"verified","canonical_digest":%q,"canonical_last_refresh":"2026-07-17T09:00:00Z","auth":{"last_refresh":"2026-07-17T09:00:00Z","claudeAiOauth":{"accessToken":"server-newer"}}}`, strings.Repeat("a", 64))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	session, err := claude.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close() //nolint:errcheck
	if _, err := uploadCurrentClaudeAuth(context.Background(), cfg, session); err == nil || !strings.Contains(err.Error(), "did not accept") {
		t.Fatalf("canonical-win upload error=%v", err)
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil || !strings.Contains(string(raw), "server-newer") {
		t.Fatalf("canonical-win upload did not converge: raw=%q err=%v", raw, err)
	}
}

func TestExplicitAuthUploadStoreFailureRetainsLogoutMarker(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	seedSameDigestLogoutIntent(t, json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"same"}}`))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"status":"error","code":"validation_error","message":"rejected"}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdAuthUpload(context.Background(), cfg, &stdout, &stderr); code != 1 {
		t.Fatalf("auth-upload code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	intent, err := claude.CurrentLogoutIntentGeneration()
	if err != nil || !intent.Exists {
		t.Fatalf("store failure cleared logout marker: intent=%+v err=%v", intent, err)
	}
}

func TestExplicitAuthUploadRejectsInvalidNativeJSONBeforeNetwork(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	authPath := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(authPath, []byte(`{broken-json`), 0o600); err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdAuthUpload(context.Background(), cfg, &stdout, &stderr); code != 1 {
		t.Fatalf("invalid auth-upload code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if requests.Load() != 0 {
		t.Fatalf("invalid auth-upload reached network: %d requests", requests.Load())
	}
}

func TestSameDigestExplicitLoginClearsOnlyAcceptedMarker(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	snap := seedSameDigestLogoutIntent(t, json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"same"}}`))
	bin := filepath.Join(t.TempDir(), "claude")
	script := "#!/bin/sh\nmkdir -p \"$HOME/.claude\"\nprintf '%s' '" + string(snap.Raw) + "' > \"$HOME/.claude/.credentials.json\"\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"valid"}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := runClaudeAuthMutation(context.Background(), cfg, []string{"auth", "login"}, &stdout, &stderr); code != 0 {
		t.Fatalf("same-digest login code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	intent, err := claude.CurrentLogoutIntentGeneration()
	if err != nil || intent.Exists {
		t.Fatalf("accepted same-digest login did not clear marker: intent=%+v err=%v", intent, err)
	}
}

func TestConcurrentSameGenerationLogoutSurvivesExplicitUploadCAS(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	snap := seedSameDigestLogoutIntent(t, json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"same"}}`))
	requestSeen := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(requestSeen)
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"valid"}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	session, err := claude.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	type uploadResult struct {
		kept bool
		err  error
	}
	done := make(chan uploadResult, 1)
	go func() {
		kept, err := uploadCurrentClaudeAuth(context.Background(), cfg, session)
		done <- uploadResult{kept: kept, err: err}
	}()
	<-requestSeen
	logoutDone := make(chan error, 1)
	go func() {
		marked, err := claude.RecordExplicitLogout(snap.Generation)
		if err == nil && !marked {
			err = errors.New("concurrent logout was not recorded")
		}
		logoutDone <- err
	}()
	select {
	case err := <-logoutDone:
		t.Fatalf("logout crossed in-flight explicit AuthStore boundary: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	got := <-done
	if got.err != nil {
		t.Fatalf("upload result kept=%v err=%v", got.kept, got.err)
	}
	if err := <-logoutDone; err != nil {
		t.Fatal(err)
	}
	intent, err := claude.CurrentLogoutIntentGeneration()
	if err != nil || !intent.Exists {
		t.Fatalf("concurrent same-generation logout was cleared: intent=%+v err=%v", intent, err)
	}
	if _, err := session.CloseAndPurgeIfLast(); err != nil {
		t.Fatal(err)
	}
}

func TestExplicitLoginStoreAppliesRunnerWritebackAlongsidePeerChild(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T08:00:00Z","claudeAiOauth":{"accessToken":"explicit-login"}}`)); err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(home, "peer-ready")
	release := filepath.Join(home, "peer-release")
	t.Setenv("CLX_PEER_READY", ready)
	t.Setenv("CLX_PEER_RELEASE", release)
	bin := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n: > \"$CLX_PEER_READY\"\nwhile [ ! -e \"$CLX_PEER_RELEASE\" ]; do sleep 0.01; done\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
	peer, err := claude.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	peerDone := make(chan error, 1)
	go func() {
		_, runErr := claude.RunWithAuthSession(context.Background(), &config.Config{}, nil, peer)
		peerDone <- runErr
	}()
	t.Cleanup(func() { _ = os.WriteFile(release, nil, 0o600) })
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("peer Claude child did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified","canonical_last_refresh":"2026-07-17T09:00:00Z","auth":{"last_refresh":"2026-07-17T09:00:00Z","claudeAiOauth":{"accessToken":"runner-refreshed"}}}`))
	}))
	defer server.Close()
	session, err := claude.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	if _, err := uploadCurrentClaudeAuth(context.Background(), cfg, session); err != nil {
		t.Fatalf("explicit login writeback error=%v", err)
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil || !strings.Contains(string(raw), "runner-refreshed") {
		t.Fatalf("runner writeback not applied alongside peer child: %q err=%v", raw, err)
	}
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := <-peerDone; err != nil {
		t.Fatal(err)
	}
	if _, err := peer.CloseAndPurgeIfLast(); err != nil {
		t.Fatal(err)
	}
	if _, err := session.CloseAndPurgeIfLast(); err != nil {
		t.Fatal(err)
	}
}

func TestStandaloneLogoutRecordsIntentAndRemovesCompatibilityMirror(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	clxDir := filepath.Join(home, ".clx", "auth")
	if err := os.MkdirAll(clxDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(clxDir, "credentials.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"logout-me"}}`)); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nrm -f \"$HOME/.claude/.credentials.json\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
	cfg := &config.Config{Host: config.Host{Secure: true}}
	var stdout, stderr bytes.Buffer
	if code := runClaudeAuthMutation(context.Background(), cfg, []string{"logout"}, &stdout, &stderr); code != 0 {
		t.Fatalf("logout code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !claude.HasLogoutIntent() {
		t.Fatal("standalone logout intent was not recorded")
	}
	if _, err := os.Stat(filepath.Join(clxDir, "credentials.json")); !os.IsNotExist(err) {
		t.Fatalf("compatibility mirror survived logout: %v", err)
	}
}

func TestExplicitLogoutDoesNotStartDestructiveCLIWhilePeerChildRuns(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"peer-in-use"}}`)); err != nil {
		t.Fatal(err)
	}
	peer, err := claude.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(home, "peer-ready")
	release := filepath.Join(home, "peer-release")
	invoked := filepath.Join(home, "logout-invoked")
	t.Setenv("CLX_PEER_READY", ready)
	t.Setenv("CLX_PEER_RELEASE", release)
	t.Setenv("CLX_LOGOUT_INVOKED", invoked)
	bin := filepath.Join(t.TempDir(), "claude")
	script := `#!/bin/sh
if [ "$1" = "logout" ]; then
  : > "$CLX_LOGOUT_INVOKED"
  rm -f "$HOME/.claude/.credentials.json"
  exit 0
fi
: > "$CLX_PEER_READY"
while [ ! -e "$CLX_PEER_RELEASE" ]; do sleep 0.01; done
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
	t.Cleanup(func() { _ = os.WriteFile(release, nil, 0o600) })
	peerDone := make(chan error, 1)
	go func() {
		_, err := claude.RunWithAuthSession(context.Background(), &config.Config{}, nil, peer)
		peerDone <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("peer Claude child did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cfg := &config.Config{Host: config.Host{Secure: true}}
	var stdout, stderr bytes.Buffer
	if code := runClaudeAuthMutation(context.Background(), cfg, []string{"logout"}, &stdout, &stderr); code != 0 {
		t.Fatalf("deferred logout code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if _, err := os.Stat(invoked); !os.IsNotExist(err) {
		t.Fatalf("destructive logout CLI ran beside peer: %v", err)
	}
	if !claude.HasUsableAuth() {
		t.Fatal("deferred logout removed auth under peer child")
	}
	if !strings.Contains(stdout.String(), "deferred") {
		t.Fatalf("deferred logout was not reported: %q", stdout.String())
	}
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := <-peerDone; err != nil {
		t.Fatal(err)
	}
	if purged, err := peer.CloseAndPurgeIfLast(); err != nil || purged {
		t.Fatalf("secure peer finalization purged=%v err=%v", purged, err)
	}
	if claude.HasUsableAuth() {
		t.Fatal("last peer exit did not complete deferred explicit logout")
	}
}

func setStatusClaudeBin(t *testing.T) {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 2.1.175\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
}

func seedSameDigestLogoutIntent(t *testing.T, payload json.RawMessage) claude.AuthSnapshot {
	t.Helper()
	if err := claude.WriteAuth(payload); err != nil {
		t.Fatal(err)
	}
	snap, err := claude.ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	if marked, err := claude.RecordExplicitLogout(snap.Generation); err != nil || !marked {
		t.Fatalf("seed logout marker marked=%v err=%v", marked, err)
	}
	if err := os.MkdirAll(filepath.Dir(snap.Path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(snap.Path, snap.Raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return snap
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

func TestUnreadableConfigCommandsAreStructuredActionableAndSanitized(t *testing.T) {
	t.Setenv("CLAUDE_WRAPPER_RESTART_DEPTH", "")
	missing := filepath.Join(t.TempDir(), "missing\x1b]2;owned\a\nFORGED\x1b[31m.json")

	t.Run("status", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := run([]string{"--minimal", "--status", "--config", missing}, &stdout, &stderr)
		if code != 1 {
			t.Fatalf("status exit = %d, want 1; stdout=%q stderr=%q", code, stdout.String(), stderr.String())
		}
		out := stdout.String()
		for _, want := range []string{"clx | status=blocked", "health | config=fail", "config=unreadable", "clx status"} {
			if !strings.Contains(out, want) {
				t.Fatalf("blocked status missing %q:\n%s", want, out)
			}
		}
		assertPortableOutput(t, out)
		if stderr.Len() != 0 {
			t.Fatalf("blocked status stderr = %q", stderr.String())
		}
	})

	t.Run("doctor", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := run([]string{"--minimal", "--doctor", "--config", missing}, &stdout, &stderr)
		if code != 1 {
			t.Fatalf("doctor exit = %d, want 1; stdout=%q stderr=%q", code, stdout.String(), stderr.String())
		}
		out := stdout.String()
		for _, want := range []string{"CLX DOCTOR", "FAIL CONFIG", "GUIDANCE", "clx doctor", "VERDICT", "FAIL RESULT"} {
			if !strings.Contains(out, want) {
				t.Fatalf("blocked doctor missing %q:\n%s", want, out)
			}
		}
		if strings.Contains(out, "DEPS") {
			t.Fatalf("config-blocked doctor ran unrelated checks:\n%s", out)
		}
		assertPortableOutput(t, out)
		if stderr.Len() != 0 {
			t.Fatalf("blocked doctor stderr = %q", stderr.String())
		}
	})

	t.Run("other command", func(t *testing.T) {
		t.Setenv("COLUMNS", "39")
		var stdout, stderr bytes.Buffer
		code := run([]string{"--minimal", "--config", missing}, &stdout, &stderr)
		if code != 2 {
			t.Fatalf("run exit = %d, want 2; stdout=%q stderr=%q", code, stdout.String(), stderr.String())
		}
		if stdout.Len() != 0 || !strings.HasPrefix(stderr.String(), "clx: config unavailable: ") {
			t.Fatalf("unexpected config failure: stdout=%q stderr=%q", stdout.String(), stderr.String())
		}
		assertPortableOutput(t, stderr.String())
		if strings.Count(stderr.String(), "\n") != 1 {
			t.Fatalf("config failure was not concise: %q", stderr.String())
		}
		if width := ui.VisibleWidth(strings.TrimSuffix(stderr.String(), "\n")); width > 39 {
			t.Fatalf("config failure width = %d, want <= 39: %q", width, stderr.String())
		}
	})
}

func assertPortableOutput(t *testing.T, output string) {
	t.Helper()
	if strings.ContainsAny(output, "\x1b\a\r") || strings.Contains(output, "\nFORGED") {
		t.Fatalf("output contains terminal/control injection: %q", output)
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
			if code := cmdCron(context.Background(), nil, subArgs, &stdout, &stderr, true); code != 2 {
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

func TestFormatCronResultMinimalIsPortable(t *testing.T) {
	line := formatCronResult(cron.Result{
		WrapperVersion: "0.6.44",
		WrapperTarget:  "0.6.45",
		WrapperAction:  "updated",
	}, true)
	assertPortableOutput(t, line)
	if !strings.Contains(line, "0.6.44 -> 0.6.45") || strings.Contains(line, "→") {
		t.Fatalf("minimal cron result = %q", line)
	}
}

func TestCronResultOutputSanitizesAndBoundsDynamicVersions(t *testing.T) {
	t.Setenv("COLUMNS", "39")
	line := formatCronResult(cron.Result{
		WrapperVersion: "0.6.44\n\x1b[31mFORGED",
		CodexVersion:   strings.Repeat("Ωlong", 20),
		Reported:       true,
	}, true)
	var out bytes.Buffer
	printBoundedPlain(&out, line, true)
	assertPortableOutput(t, out.String())
	if strings.Count(out.String(), "\n") != 1 {
		t.Fatalf("cron result forged extra rows: %q", out.String())
	}
	if strings.Contains(out.String(), "Ω") {
		t.Fatalf("cron result is not portable ASCII: %q", out.String())
	}
	if width := ui.VisibleWidth(strings.TrimSuffix(out.String(), "\n")); width > 39 {
		t.Fatalf("cron result width = %d, want <= 39: %q", width, out.String())
	}
}

func TestCronUnknownActionSanitizesAndBoundsInput(t *testing.T) {
	t.Setenv("COLUMNS", "39")
	var stdout, stderr bytes.Buffer
	action := "bad\n\x1b[31mFORGED" + strings.Repeat("Ω", 40)
	if code := cmdCron(context.Background(), nil, []string{action}, &stdout, &stderr, true); code != 2 {
		t.Fatalf("cmdCron exit = %d, want 2", code)
	}
	assertPortableOutput(t, stderr.String())
	lines := strings.Split(strings.TrimSuffix(stderr.String(), "\n"), "\n")
	if len(lines) != 2 || ui.VisibleWidth(lines[0]) > 39 {
		t.Fatalf("unexpected bounded cron error: %q", stderr.String())
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

package codexapp

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
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/ui"
)

func TestHelpChildLeasesBlockMutationsAndServicePendingPurge(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	authPath := filepath.Join(dir, "auth.json")
	if err := codex.WriteAuth(json.RawMessage(`{"tokens":{"access_token":"temporary"}}`)); err != nil {
		t.Fatal(err)
	}
	insecure, err := codex.StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(dir, "ready")
	type helpResult struct {
		exit    int
		removed bool
		err     error
	}
	result := make(chan helpResult, 1)
	t.Setenv("CDX_HELP_LEASE_READY", ready)
	go func() {
		exit, removed, err := runHelpChild(context.Background(), "/bin/sh", []string{"-c", `touch "$CDX_HELP_LEASE_READY"; sleep 0.4`}, io.Discard, io.Discard)
		result <- helpResult{exit: exit, removed: removed, err: err}
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("supervised help child did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if maintenance, err := codex.TryAcquireAuthMaintenance(); !errors.Is(err, ipc.ErrHeld) {
		if maintenance != nil {
			_ = maintenance.Release()
		}
		t.Fatalf("inherited session lease missing: %v", err)
	}
	expected, _ := codex.CurrentAuthGeneration()
	wrote, err := codex.WriteAuthIfCurrent(json.RawMessage(`{"tokens":{"access_token":"server"}}`), expected)
	if err != nil || !wrote {
		t.Fatalf("guarded canonical write did not pass active child: wrote=%v err=%v", wrote, err)
	}
	if removed, deferred, err := codex.FinishAuthSession(insecure); err != nil || removed || !deferred {
		t.Fatalf("insecure peer finish while help active = removed=%v deferred=%v err=%v", removed, deferred, err)
	}
	if _, err := os.Stat(authPath); err != nil {
		t.Fatalf("auth purged while help child could still use it: %v", err)
	}
	got := <-result
	if got.exit != 0 || !got.removed || got.err != nil {
		t.Fatalf("help result = exit=%d removed=%v err=%v", got.exit, got.removed, got.err)
	}
	if _, err := os.Stat(authPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("last help session stranded insecure auth: %v", err)
	}
	maintenance, err := codex.TryAcquireAuthMaintenance()
	if err != nil {
		t.Fatalf("leases survived child exit: %v", err)
	}
	_ = maintenance.Release()
}

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

func TestHelpExecArgvStripsWrapperMinimalBeforeSentinel(t *testing.T) {
	got := helpExecArgv([]string{"--minimal", "exec", "--minimal-output", "--help", "--", "--minimal"})
	want := []string{"exec", "--help", "--", "--minimal"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("helpExecArgv = %v, want %v", got, want)
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
	if !strings.Contains(help.String(), "CDX WRAPPER HELP") || strings.ContainsAny(help.String(), "╭╮╰╯│") {
		t.Fatalf("minimal help is not the plain renderer:\n%s", help.String())
	}

	updates := []string{
		ui.UpdateProgress(caps, "cdx", "wrapper", "0.6.44", "0.6.45"),
		ui.UpdateComplete(caps, "cdx", "wrapper", "0.6.45", false),
		ui.UpdateFailure(caps, "cdx", "wrapper", "0.6.45", fmt.Errorf("checksum mismatch")),
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
	got := executeLifecycleOptions(flags{minimal: true, allowConc: true})
	if !got.Minimal || !got.SkipBoot || !got.Headless || !got.AllowConcurrentSync {
		t.Fatalf("execute lifecycle options lost wrapper flags: %+v", got)
	}
}

func TestPrintLifecycleErrorIsPortable(t *testing.T) {
	var out bytes.Buffer
	printLifecycleError(&out, "cdx run", fmt.Errorf("denied Ω\n\x1b[31mforged"))
	assertPortableOutput(t, out.String())
	if strings.Count(out.String(), "\n") != 1 {
		t.Fatalf("dynamic error forged extra rows: %q", out.String())
	}
}

func TestPrintBoundedPlainRedirectedUsesASCII(t *testing.T) {
	t.Setenv("COLUMNS", "24")
	var out bytes.Buffer
	printBoundedPlain(&out, "cdx: "+strings.Repeat("long ", 20), false)
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

func TestStatusPurgesMaterializedAuthOnLastInsecureCommand(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"outdated","auth":{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"temporary"}},"host":{"secure":false}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: false}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdStatus(context.Background(), cfg, "test", &stdout, &stderr, true); code != 0 {
		t.Fatalf("status = %d stderr=%q", code, stderr.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "auth.json")); !os.IsNotExist(err) {
		t.Fatalf("insecure status left auth behind: %v", err)
	}
}

func TestAuthUploadPurgesAuthOnLastInsecureCommand(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"tokens":{"access_token":"login"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified","host":{"secure":false}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: false}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdAuthUpload(context.Background(), cfg, &stdout, &stderr); code != 0 {
		t.Fatalf("auth-upload = %d stderr=%q", code, stderr.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "auth.json")); !os.IsNotExist(err) {
		t.Fatalf("insecure auth-upload left auth behind: %v", err)
	}
}

func TestAuthUploadRetainsLogoutIntentUntilStoreAccepted(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(path, []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"login"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	generation, _ := codex.CurrentAuthGeneration()
	if marked, err := codex.MarkLogoutIntent(generation); err != nil || !marked {
		t.Fatalf("mark logout = %v, %v", marked, err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"code":"runner_unreachable","message":"runner unavailable"}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdAuthUpload(context.Background(), cfg, &stdout, &stderr); code == 0 {
		t.Fatalf("auth-upload unexpectedly succeeded: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	if active, err := codex.LogoutIntentActive(); err != nil || !active {
		t.Fatalf("failed store erased logout intent: active=%v err=%v", active, err)
	}
}

func TestAuthUploadOutdatedArbitrationDoesNotClaimOrAcknowledgeAcceptance(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	local := []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"local-login"}}`)
	if err := os.WriteFile(path, local, 0o600); err != nil {
		t.Fatal(err)
	}
	generation, _ := codex.CurrentAuthGeneration()
	if marked, err := codex.MarkLogoutIntent(generation); err != nil || !marked {
		t.Fatalf("mark logout = %v, %v", marked, err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"outdated","verification_state":"verified","canonical_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","canonical_last_refresh":"2026-07-17T11:00:00Z","auth":{"last_refresh":"2026-07-17T11:00:00Z","tokens":{"access_token":"canonical"}},"host":{"secure":true}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdAuthUpload(context.Background(), cfg, &stdout, &stderr); code == 0 {
		t.Fatalf("outdated upload claimed success: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	if strings.Contains(stdout.String(), "auth-upload: ok") {
		t.Fatalf("outdated upload printed success: %q", stdout.String())
	}
	if active, err := codex.LogoutIntentActive(); err != nil || !active {
		t.Fatalf("outdated store erased logout intent: active=%v err=%v", active, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("read auth after rejected upload: %v", err)
	}
	if err == nil && !bytes.Equal(raw, local) {
		t.Fatalf("outdated store replaced logged-out generation: %q", raw)
	}
}

func TestAuthUploadAcknowledgesMarkerObservedBeforeAcceptedStore(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	local := []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"login"}}`)
	if err := os.WriteFile(path, local, 0o600); err != nil {
		t.Fatal(err)
	}
	generation, _ := codex.CurrentAuthGeneration()
	if marked, err := codex.MarkLogoutIntent(generation); err != nil || !marked {
		t.Fatalf("mark logout = %v, %v", marked, err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified","auth":{"last_refresh":"2026-07-17T11:00:00Z","tokens":{"access_token":"server"}},"host":{"secure":true}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdAuthUpload(context.Background(), cfg, &stdout, &stderr); code != 0 {
		t.Fatalf("auth-upload = %d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if active, err := codex.LogoutIntentActive(); err != nil || active {
		t.Fatalf("accepted explicit upload left prior logout intent active=%v err=%v", active, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), `"access_token":"server"`) {
		t.Fatalf("auth writeback = %s, %v", raw, err)
	}
}

func TestAuthUploadRetriesOneInFlightGenerationChangeAndFailsOnSecond(t *testing.T) {
	for _, tc := range []struct {
		name        string
		changes     int
		wantCode    int
		wantCalls   int
		wantCurrent string
	}{
		{name: "one overlap converges", changes: 1, wantCode: 0, wantCalls: 2, wantCurrent: "login-b"},
		{name: "second overlap fails visibly", changes: 2, wantCode: 1, wantCalls: 2, wantCurrent: "login-c"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("CODEX_HOME", dir)
			path := filepath.Join(dir, "auth.json")
			payloads := [][]byte{
				[]byte(`{"last_refresh":"2026-07-18T10:00:00Z","tokens":{"access_token":"login-a"}}`),
				[]byte(`{"last_refresh":"2026-07-18T10:00:01Z","tokens":{"access_token":"login-b"}}`),
				[]byte(`{"last_refresh":"2026-07-18T10:00:02Z","tokens":{"access_token":"login-c"}}`),
			}
			if err := os.WriteFile(path, payloads[0], 0o600); err != nil {
				t.Fatal(err)
			}
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var req struct {
					Command string          `json:"command"`
					Auth    json.RawMessage `json:"auth"`
				}
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					t.Errorf("decode store %d: %v", calls, err)
					return
				}
				if req.Command != "store" || calls > len(payloads) || !strings.Contains(string(req.Auth), "login-"+string(rune('a'+calls-1))) {
					t.Errorf("store %d = command %q auth %s", calls, req.Command, req.Auth)
				}
				// Native Codex does not honor the wrapper flock. Model another
				// overlapping process atomically replacing auth.json while this
				// request is in flight.
				if calls <= tc.changes {
					if err := os.WriteFile(path, payloads[calls], 0o600); err != nil {
						t.Errorf("write overlapping generation %d: %v", calls, err)
					}
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified"}`))
			}))
			defer server.Close()

			cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
			var stdout, stderr bytes.Buffer
			if code := cmdAuthUpload(context.Background(), cfg, &stdout, &stderr); code != tc.wantCode {
				t.Fatalf("auth-upload code=%d want=%d stdout=%q stderr=%q", code, tc.wantCode, stdout.String(), stderr.String())
			}
			if calls != tc.wantCalls {
				t.Fatalf("store calls=%d want=%d stdout=%q stderr=%q", calls, tc.wantCalls, stdout.String(), stderr.String())
			}
			raw, err := os.ReadFile(path)
			if err != nil || !strings.Contains(string(raw), tc.wantCurrent) {
				t.Fatalf("current auth=%q err=%v want=%q", raw, err, tc.wantCurrent)
			}
			if tc.wantCode != 0 && strings.Contains(stdout.String(), "auth-upload: ok") {
				t.Fatalf("stale generation reported success: stdout=%q", stdout.String())
			}
		})
	}
}

func TestStatusReportsExplicitLogoutAsFailureEvenWhenCanonicalIsValid(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	auth := []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"same"}}`)
	if err := os.WriteFile(path, auth, 0o600); err != nil {
		t.Fatal(err)
	}
	generation, _ := codex.CurrentAuthGeneration()
	if marked, err := codex.MarkLogoutIntent(generation); err != nil || !marked {
		t.Fatalf("mark logout = %v, %v", marked, err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"valid","verification_state":"verified","host":{"secure":true}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdStatus(context.Background(), cfg, "test", &stdout, &stderr, true); code != 1 {
		t.Fatalf("status exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(strings.ToLower(stdout.String()), "explicitly logged out") {
		t.Fatalf("status hid explicit logout: %q", stdout.String())
	}
	if active, err := codex.LogoutIntentActive(); err != nil || !active {
		t.Fatalf("status cleared logout intent: active=%v err=%v", active, err)
	}
}

func TestStatusSurfacesLocalAuthStateErrorsBeforeNetwork(t *testing.T) {
	for _, markerDirectory := range []bool{true, false} {
		name := "auth-generation"
		if markerDirectory {
			name = "logout-marker"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("CODEX_HOME", dir)
			if markerDirectory {
				if err := os.Mkdir(filepath.Join(dir, ".cdx-logout-intent.json"), 0o700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Mkdir(filepath.Join(dir, "auth.json"), 0o700); err != nil {
				t.Fatal(err)
			}
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests++
				_, _ = w.Write([]byte(`{"status":"valid"}`))
			}))
			defer server.Close()
			cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
			var stdout, stderr bytes.Buffer
			if code := cmdStatus(context.Background(), cfg, "test", &stdout, &stderr, true); code == 0 {
				t.Fatalf("status swallowed local error: stdout=%q stderr=%q", stdout.String(), stderr.String())
			}
			if requests != 0 {
				t.Fatalf("status made %d request(s) with unreadable local auth state", requests)
			}
		})
	}
}

func TestStatusMaterializesRequiredCanonicalWriteAlongsideActiveChild(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 0.144.1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)
	child, err := codex.AcquireActiveChild()
	if err != nil {
		t.Fatal(err)
	}
	defer child.Release()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"outdated","verification_state":"verified","auth":{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"required"}},"host":{"secure":true}}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test"}}
	var stdout, stderr bytes.Buffer
	if code := cmdStatus(context.Background(), cfg, "test", &stdout, &stderr, true); code != 0 {
		t.Fatalf("status rejected authoritative auth: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	if raw, err := os.ReadFile(filepath.Join(dir, "auth.json")); err != nil || !bytes.Contains(raw, []byte("required")) {
		t.Fatalf("status did not materialize auth during peer child: %q %v", raw, err)
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

func TestUnreadableConfigCommandsAreStructuredActionableAndSanitized(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTART_DEPTH", "")
	missing := filepath.Join(t.TempDir(), "missing\x1b]2;owned\a\nFORGED\x1b[31m.json")

	t.Run("status", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := run([]string{"--minimal", "--status", "--config", missing}, &stdout, &stderr)
		if code != 1 {
			t.Fatalf("status exit = %d, want 1; stdout=%q stderr=%q", code, stdout.String(), stderr.String())
		}
		out := stdout.String()
		for _, want := range []string{"cdx | status=blocked", "health | config=fail", "config=unreadable", "cdx status"} {
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
		for _, want := range []string{"CDX DOCTOR", "FAIL CONFIG", "GUIDANCE", "cdx doctor", "VERDICT", "FAIL RESULT"} {
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
		if stdout.Len() != 0 || !strings.HasPrefix(stderr.String(), "cdx: config unavailable: ") {
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
			if code := cmdCron(context.Background(), nil, subArgs, &stdout, &stderr, true); code != 2 {
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

func TestSuccessfulUnchangedLoginStillUploadsForFleetVerification(t *testing.T) {
	if !loginNeedsAuthUpload(0, "same", "same", true) {
		t.Fatal("byte-identical explicit login did not supersede logout intent through accepted upload")
	}
	if !loginNeedsAuthUpload(0, "same", "same", false) {
		t.Fatal("successful real login did not prove unchanged credentials through server/runner upload")
	}
	if loginNeedsAuthUpload(1, "same", "same", true) {
		t.Fatal("failed login was allowed to acknowledge logout intent")
	}
}

func TestLoginStatusInvocationIsAlwaysReadOnly(t *testing.T) {
	for _, tc := range []struct {
		subArgs, passthrough []string
		want                 bool
	}{
		{subArgs: []string{"status"}, want: true},
		{subArgs: []string{"--json", "status"}, want: true},
		{passthrough: []string{"status"}, want: true},
		{subArgs: nil, want: false},
		{subArgs: []string{"--device-auth"}, want: false},
	} {
		if got := loginStatusInvocation(tc.subArgs, tc.passthrough); got != tc.want {
			t.Fatalf("loginStatusInvocation(%v,%v)=%v want %v", tc.subArgs, tc.passthrough, got, tc.want)
		}
	}
}

func TestLoginCompletionExitFailsWhenFleetUploadFails(t *testing.T) {
	if got := loginCompletionExit(0, 1); got != 1 {
		t.Fatalf("successful upstream login masked upload failure: %d", got)
	}
	if got := loginCompletionExit(7, 0); got != 7 {
		t.Fatalf("upstream login exit lost: %d", got)
	}
}

func TestDirectLoginDigestSnapshotSurfacesReadFailure(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	if err := os.Mkdir(filepath.Join(dir, "auth.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := directLoginDigestSnapshot(); err == nil || !strings.Contains(err.Error(), "local auth digest") {
		t.Fatalf("digest snapshot error = %v", err)
	}
}

func TestLogoutDoesNotMarkConcurrentNewerLogin(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.json")
	before := codex.AuthGeneration{Exists: true, Digest: "old"}
	after := codex.AuthGeneration{Exists: true, Digest: "new"}
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"new-login"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if logoutGenerationMayBeMarked(before, after, path) {
		t.Fatal("concurrent usable login was marked as logged out")
	}
	if !logoutGenerationMayBeMarked(before, codex.AuthGeneration{}, path) {
		t.Fatal("normal logout removal was not markable")
	}
}

// TestSyncIsWrapperOwnedNotProfileShorthand: without this, a config.toml with a
// [profiles.sync] section would silently turn `cdx sync` into a Codex launch.
func TestSyncIsWrapperOwnedNotProfileShorthand(t *testing.T) {
	if isProfileShorthand("sync") {
		t.Fatal("sync is resolvable as profile shorthand")
	}
	if reservedCodexSubcommands["sync"] {
		t.Fatal("sync must not be passed through to the upstream codex CLI")
	}
}

// TestSyncConflictsWithOtherWrapperActions: `cdx sync --update` is ambiguous and
// must be rejected before any config load or network call.
func TestSyncConflictsWithOtherWrapperActions(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if got := Run([]string{"sync", "--update"}, &stdout, &stderr); got != 2 {
		t.Fatalf("exit = %d, want 2", got)
	}
	if !strings.Contains(stderr.String(), "conflicting wrapper actions") {
		t.Fatalf("stderr did not name the conflict: %q", stderr.String())
	}
}

// TestPostUpdateSyncArgvPreservesConfigAndPresentation: dropping --config here
// would re-exec into a sync that loads a different host's configuration.
func TestPostUpdateSyncArgvPreservesConfigAndPresentation(t *testing.T) {
	cases := []struct {
		name string
		host bool
		in   flags
		want []string
	}{
		{"bare", false, flags{}, []string{"sync"}},
		{"config", false, flags{configPath: "/etc/cdx.json"}, []string{"sync", "--config", "/etc/cdx.json"}},
		{"presentation", false, flags{minimal: true, silent: true, skipBoot: true}, []string{"sync", "--minimal", "--silent", "--skip-boot"}},
		// `cxx sync` resolves each installed engine's own config and rejects a
		// single --config outright. Emitting one here would make the update
		// re-exec land on an argv the host command exits 2 on — leaving the new
		// binary installed and the content unsynced, the exact failure this
		// whole path exists to prevent.
		{"host form drops config", true, flags{configPath: "/etc/cdx.json", minimal: true}, []string{"sync", "--minimal"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			previous := HostSyncAfterUpdate
			t.Cleanup(func() { HostSyncAfterUpdate = previous })
			HostSyncAfterUpdate = tc.host
			if got := postUpdateSyncArgv(tc.in); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("postUpdateSyncArgv() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestHostSyncAfterUpdateSelectsHostReexecForm: a dual-engine host updated via
// `cxx update` must sync both engines, not just the one that authenticated.
func TestHostSyncAfterUpdateSelectsHostReexecForm(t *testing.T) {
	previous := HostSyncAfterUpdate
	t.Cleanup(func() { HostSyncAfterUpdate = previous })

	HostSyncAfterUpdate = false
	if got := postUpdateSyncEngine(); got != config.EngineCodex {
		t.Fatalf("persona update engine = %q, want %q", got, config.EngineCodex)
	}
	HostSyncAfterUpdate = true
	if got := postUpdateSyncEngine(); got != "" {
		t.Fatalf("cxx update engine = %q, want the host form", got)
	}
}

// TestFormatCronResultReportsFailedSync: a silent content-sync failure would
// otherwise render as "cron: ok".
func TestFormatCronResultReportsFailedSync(t *testing.T) {
	healthy := formatCronResult(cron.Result{WrapperVersion: "0.7.0", CodexVersion: "1.0.0", Reported: true}, true)
	if strings.Contains(healthy, "sync=") {
		t.Fatalf("healthy tick grew a sync marker: %q", healthy)
	}
	failed := formatCronResult(cron.Result{WrapperVersion: "0.7.0", CodexVersion: "1.0.0", Reported: true, SyncAction: "failed"}, true)
	if !strings.Contains(failed, "sync=failed") {
		t.Fatalf("failed sync stayed invisible: %q", failed)
	}
}

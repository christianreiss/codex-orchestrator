package lifecycle

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
)

func TestPresentedErrorAndPortableLifecycleText(t *testing.T) {
	err := errors.New("denied → next\n\x1b[31m")
	marked := markPresented(err, Options{SkipBoot: false})
	if !ErrorWasPresented(marked) || ErrorWasPresented(markPresented(err, Options{SkipBoot: true})) {
		t.Fatal("presented-error marker does not match boot visibility")
	}
	if got := safeLifecycleText(err.Error(), true); strings.ContainsAny(got, "→\n\r\x1b") {
		t.Fatalf("portable lifecycle text leaked controls/Unicode: %q", got)
	}
}

func TestFooterCapsKeepsMinimalRunsCompact(t *testing.T) {
	caps := ui.Caps{IsTTY: true, Palette: ui.Palette{Reset: "ansi"}}
	got := footerCaps(caps, true)
	if got.IsTTY || got.Palette.Reset != "" {
		t.Fatalf("minimal footer retained rich capabilities: %+v", got)
	}
	if got := footerCaps(caps, false); !got.IsTTY || got.Palette.Reset != "ansi" {
		t.Fatalf("normal footer lost rich capabilities: %+v", got)
	}
}

func TestConcurrentNoteExplainsManagedSyncPause(t *testing.T) {
	got := concurrentNote(true, orchestrator.AuthDecision{LocalUsable: true})
	if !strings.Contains(got, "Managed content sync paused") || !strings.Contains(got, "auth freshness remains active") || strings.Contains(strings.ToLower(got), "read-only") {
		t.Fatalf("concurrent note = %q", got)
	}
}

func TestUpdateCapsHonorsMinimal(t *testing.T) {
	t.Setenv("TERM", "xterm-256color")
	t.Setenv("LANG", "C.UTF-8")
	got := updateCaps(nil, true)
	if got.IsTTY || !got.Dumb || got.UTF8 || got.Palette.Reset != "" {
		t.Fatalf("minimal update caps = %+v", got)
	}
}

func TestBuildSessionCountsMirrorsFleetAndLocalValues(t *testing.T) {
	if got := buildSessionCounts(nil); got != nil {
		t.Fatalf("nil fleet sessions = %+v", got)
	}
	got := buildSessionCounts(&orchestrator.FleetSessions{Now: 7, Today: 21, Month: 314})
	if got == nil || got.LocalNow < 1 || got.FleetNow != 7 || got.Today != 21 || got.Month != 314 {
		t.Fatalf("session counts = %+v", got)
	}
}

func TestApplyBundleClaudeSkillsPreservesAbsentFieldCompatibility(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	absent := applyBundleClaudeSkills(nil, logger)
	if absent.Checked || absent.Updated || absent.Err != nil {
		t.Fatalf("absent claude_skills produced a resource outcome: %+v", absent)
	}

	empty := applyBundleClaudeSkills([]orchestrator.CollectionItem{}, logger)
	if !empty.Checked || empty.Updated || empty.Err != nil {
		t.Fatalf("explicit empty claude_skills was not a successful check: %+v", empty)
	}
}

func TestCombineOptionalResourceSyncKeepsLegacyProbeAndPropagatesFailure(t *testing.T) {
	base := summary.ResourceSync{Checked: true, Updated: true}
	if got := combineOptionalResourceSync(base, summary.ResourceSync{}); !got.Checked || !got.Updated || got.Err != nil {
		t.Fatalf("absent optional state changed base probe: %+v", got)
	}

	wantErr := errors.New("native skill write failed")
	got := combineOptionalResourceSync(base, summary.ResourceSync{Checked: true, Err: wantErr})
	if !got.Checked || !got.Updated || !errors.Is(got.Err, wantErr) {
		t.Fatalf("native skill failure was not propagated: %+v", got)
	}
}

func TestBootstrapRoutesClaudeSkillFailureAwayFromConfigStatus(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sync/bootstrap" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"status":"success","auth":{"status":"valid"},"claude_skills":[{"slug":"reviewer","sha256":"sha-reviewer","status":"updated"}]}}`))
	}))
	defer server.Close()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	_, bootstrapErr, _, _, configSync, nativeSkillsSync, _ := bootstrap(
		context.Background(), client, logger, false, "",
	)
	if bootstrapErr != nil {
		t.Fatalf("bootstrap returned transport error: %v", bootstrapErr)
	}
	if configSync.Err != nil {
		t.Fatalf("native skill failure leaked into config status: %v", configSync.Err)
	}
	if !nativeSkillsSync.Checked || nativeSkillsSync.Err == nil {
		t.Fatalf("native skill failure missing from skills status: %+v", nativeSkillsSync)
	}
}

func TestRunRejectsFQDNMismatchBeforeNetworkAndBoot(t *testing.T) {
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"valid"}`))
	}))
	defer server.Close()

	cfg := &config.Config{
		Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"},
		Host: config.Host{
			FQDN: "definitely-not-this-host.example.invalid\x1b[31m\nforged",
		},
	}
	var (
		exitCode int
		runErr   error
	)
	exitCode, runErr = Run(context.Background(), Options{
		Config: cfg,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	if exitCode != 1 || runErr == nil {
		t.Fatalf("Run mismatch = (%d, %v), want (1, error)", exitCode, runErr)
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("FQDN guard ran after network activity: %d requests", got)
	}
	portable := safeLifecycleText(runErr.Error(), true)
	if strings.Contains(strings.ToLower(portable), "ready") {
		t.Fatalf("mismatch returned a green-ready result: %q", portable)
	}
	if !strings.Contains(portable, "CLAUDE_ALLOW_FQDN_MISMATCH=1") {
		t.Fatalf("mismatch error is not actionable: %q", portable)
	}
	if strings.ContainsAny(portable, "\r\n\x1b") {
		t.Fatalf("mismatch error contains unsanitized terminal controls: %q", portable)
	}
}

func TestCurrentWrapperVersionPrefersRunningVersion(t *testing.T) {
	cfg := &config.Config{Wrapper: config.Wrapper{Version: "0.6.18"}}
	got := currentWrapperVersion(Options{WrapperVersion: "0.6.23"}, cfg)
	if got != "0.6.23" {
		t.Fatalf("currentWrapperVersion() = %q, want running version", got)
	}
}

func TestCurrentWrapperVersionFallsBackToConfig(t *testing.T) {
	cfg := &config.Config{Wrapper: config.Wrapper{Version: "0.6.18"}}
	got := currentWrapperVersion(Options{}, cfg)
	if got != "0.6.18" {
		t.Fatalf("currentWrapperVersion() = %q, want config version", got)
	}
}

func TestMaybeEnsureClaudeSkipsMatchingTargetWithoutProgressLine(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)

	claudePath := filepath.Join(bin, "claude")
	npmPath := filepath.Join(bin, "npm")
	marker := filepath.Join(dir, "npm-called")
	writeTestScript(t, claudePath, `#!/bin/sh
echo "2.1.168"
`)
	writeTestScript(t, npmPath, `#!/bin/sh
echo called > "`+marker+`"
exit 42
`)
	t.Setenv("CLX_CLAUDE_BIN", claudePath)
	t.Setenv("PATH", bin)

	target := "2.1.168"
	auth := &orchestrator.AuthRetrieveResponse{
		Versions: &orchestrator.VersionSummary{
			AutoUpdateEnabled:         true,
			ClientVersion:             &target,
			ClientVersionEnforceExact: true,
		},
	}

	stderr := captureStderr(t, func() {
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		if got := maybeEnsureClaude(context.Background(), nil, auth, false, false, logger); got != "" {
			t.Fatalf("maybeEnsureClaude() = %q, want no update", got)
		}
	})
	if strings.Contains(stderr, "installing claude CLI") || strings.Contains(stderr, "claude CLI updated") {
		t.Fatalf("unexpected update progress on stderr: %q", stderr)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("npm was called for an already matching target; stat err=%v", err)
	}
}

func TestNeedsInteractiveAuthRecovery(t *testing.T) {
	cases := []struct {
		name      string
		decision  orchestrator.AuthDecision
		uploadErr error
		want      bool
	}{
		{
			name: "live verification failure",
			decision: orchestrator.AuthDecision{
				Status: "valid",
				Reason: "Claude credentials failed live verification (login expired).",
			},
			want: true,
		},
		{
			name: "missing with upload failure",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "missing",
			},
			uploadErr: errors.New("runner rejected token"),
			want:      true,
		},
		{
			name: "normal valid auth",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "valid",
			},
			want: false,
		},
		{
			name: "disabled host is not a login recovery",
			decision: orchestrator.AuthDecision{
				Status: "disabled",
				Reason: "Auth API disabled by administrator.",
			},
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := needsInteractiveAuthRecovery(tc.decision, tc.uploadErr); got != tc.want {
				t.Fatalf("needsInteractiveAuthRecovery() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestShouldWriteServerAuth(t *testing.T) {
	auth := []byte(`{"claudeAiOauth":{"accessToken":"token"}}`)
	cases := []struct {
		status string
		auth   []byte
		want   bool
	}{
		{"outdated", auth, true},
		{"updated", auth, true},
		{"missing", auth, true},
		{" OUTDATED ", auth, true},
		{"valid", auth, false},
		{"outdated", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.status, func(t *testing.T) {
			if got := shouldWriteServerAuth(tc.status, tc.auth); got != tc.want {
				t.Fatalf("shouldWriteServerAuth(%q, len=%d) = %v, want %v", tc.status, len(tc.auth), got, tc.want)
			}
		})
	}
}

func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	defer func() {
		os.Stderr = orig
		_ = r.Close()
	}()

	fn()
	_ = w.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func writeTestScript(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

package lifecycle

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/ui"
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

func TestLaunchArgsForAuthUsesEffectiveLaneWithoutGuessingOffline(t *testing.T) {
	base := []string{"resume", "abc"}
	validDefault := launchArgsForAuth(base, &orchestrator.AuthRetrieveResponse{
		Status:  "valid",
		Host:    &orchestrator.HostInfo{},
		ChatGPT: &orchestrator.ChatGPTQuota{ActiveLane: "normal"},
	})
	if !reflect.DeepEqual(validDefault, base) {
		t.Fatalf("quota-display default overrode fleet model args: %v", validDefault)
	}
	normal := launchArgsForAuth(base, &orchestrator.AuthRetrieveResponse{
		Status: "valid",
		Host:   &orchestrator.HostInfo{LanePreference: "normal"},
	})
	if len(normal) < 2 || normal[0] != "--model" || normal[1] != "gpt-5.6-terra" {
		t.Fatalf("normal lane args = %v", normal)
	}
	spark := launchArgsForAuth(base, &orchestrator.AuthRetrieveResponse{
		Status: "valid",
		Host:   &orchestrator.HostInfo{LanePreference: "spark"},
	})
	if len(spark) < 2 || spark[1] != "gpt-5.3-codex-spark" {
		t.Fatalf("spark lane args = %v", spark)
	}
	offline := launchArgsForAuth(base, &orchestrator.AuthRetrieveResponse{Status: "offline"})
	if !reflect.DeepEqual(offline, base) {
		t.Fatalf("offline lane was guessed: %v", offline)
	}
}

func TestWriteAgentsPropagatesLocalWriteFailure(t *testing.T) {
	homeFile := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(homeFile, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", homeFile)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":{"content":"fleet agents"}}`)
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	updated, err := writeAgents(context.Background(), client)
	if updated || err == nil {
		t.Fatalf("writeAgents = (%t, %v), want propagated write failure", updated, err)
	}
}

func TestManagedCodexPathsHonorCodexHome(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	agents, err := agentsPath()
	if err != nil || agents != filepath.Join(dir, "AGENTS.md") {
		t.Fatalf("agentsPath = %q, %v", agents, err)
	}
	configPath, err := configTomlPath()
	if err != nil || configPath != filepath.Join(dir, "config.toml") {
		t.Fatalf("configTomlPath = %q, %v", configPath, err)
	}
}

func TestApplyQuotaHardFailOverrideReclassifiesScreen(t *testing.T) {
	state := ui.ScreenInput{
		QuotaBlock:  "weekly quota reached (100% used)",
		ResultLabel: "Quota blocked.", ResultTone: ui.ToneFail,
	}
	original := applyQuotaHardFailOverride(&state)
	if original == "" || state.QuotaBlock != "" || state.QuotaWarn == "" {
		t.Fatalf("quota override did not reclassify block: original=%q state=%+v", original, state)
	}
	if state.ResultTone != ui.ToneWarn || !strings.Contains(state.ResultLabel, "launching") {
		t.Fatalf("quota override still looks blocked: %+v", state)
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
				Status:             "outdated",
				Reason:             "Codex credentials failed live verification (login expired).",
				VerificationFailed: true,
			},
			want: true,
		},
		{
			name: "missing with definitive 4xx upload rejection",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "missing",
			},
			uploadErr: &orchestrator.HTTPError{StatusCode: 400, Code: "validation_failed", Method: "POST", Path: "/auth", Body: "candidate failed live verification"},
			want:      true,
		},
		{
			name: "security 403 is not credential rejection",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "upload_required",
			},
			uploadErr: &orchestrator.HTTPError{StatusCode: 403, Code: "engine_disabled", Method: "POST", Path: "/auth"},
			want:      false,
		},
		{
			name: "unusable runner writeback fails without login loop",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "upload_required",
			},
			uploadErr: &orchestrator.HTTPError{StatusCode: 503, Code: "runner_updated_auth_invalid", Method: "POST", Path: "/auth"},
			want:      false,
		},
		{
			name: "upload_required with gated store (503) must not prompt a login loop",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "upload_required",
			},
			uploadErr: &orchestrator.HTTPError{StatusCode: 503, Method: "POST", Path: "/auth", Body: "Auth runner unavailable"},
			want:      false,
		},
		{
			name: "upload_required with transport failure must not prompt a login loop",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "upload_required",
			},
			uploadErr: errors.New("dial tcp: connection refused"),
			want:      false,
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
			if got := needsInteractiveAuthRecovery(tc.decision, tc.uploadErr, false); got != tc.want {
				t.Fatalf("needsInteractiveAuthRecovery() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMissingServerExpiredAccessJWTTriggersRecovery(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, err := codex.AuthPath()
	if err != nil {
		t.Fatal(err)
	}
	expiredPayload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"exp":%d}`, time.Now().Add(-time.Hour).Unix())))
	expired := "header." + expiredPayload + ".signature"
	stamp := time.Now().UTC().Format(time.RFC3339)
	decision := orchestrator.AuthDecision{Allowed: true, Status: "missing"}

	if err := os.WriteFile(path, []byte(`{"last_refresh":"`+stamp+`","tokens":{"access_token":"`+expired+`"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	needed := needsInteractiveAuthRecovery(decision, nil, false)
	if !needed {
		t.Fatal("missing server auth plus expired access JWT without refresh token suppressed recovery")
	}
	if got := decideAuthRecovery(false, false, needed); got != authRecoveryInteractive {
		t.Fatalf("interactive recovery action = %v, want %v", got, authRecoveryInteractive)
	}
	if got := decideAuthRecovery(false, true, needed); got != authRecoveryFailClosed {
		t.Fatalf("headless recovery action = %v, want %v", got, authRecoveryFailClosed)
	}

	if err := os.WriteFile(path, []byte(`{"last_refresh":"`+stamp+`","tokens":{"access_token":"`+expired+`","refresh_token":"refresh"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if needsInteractiveAuthRecovery(decision, nil, false) {
		t.Fatal("expired access JWT with a native refresh token incorrectly forced login")
	}

	oldStamp := time.Now().UTC().Add(-3 * 24 * time.Hour).Format(time.RFC3339)
	if err := os.WriteFile(path, []byte(`{"last_refresh":"`+oldStamp+`","tokens":{"access_token":"opaque","refresh_token":"refresh"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if !needsInteractiveAuthRecovery(decision, nil, false) {
		t.Fatal("non-secure host used auth outside the 24-hour cache window")
	}
	if needsInteractiveAuthRecovery(decision, nil, true) {
		t.Fatal("secure host failed to use runnable auth inside the 7-day cache window")
	}
}

// TestDecideAuthRecovery pins the launch-gate rule that headless callers
// (cron, --execute) fail closed instead of opening an interactive `codex login`
// prompt — the spec's "Non-interactive runs fail closed" guarantee, which the
// gate previously only enforced via term.IsTerminal (so --execute on a TTY
// would still prompt).
func TestDecideAuthRecovery(t *testing.T) {
	cases := []struct {
		name                            string
		concurrent, headless, recovered bool
		want                            authRecoveryAction
	}{
		{"interactive run recovers", false, false, true, authRecoveryInteractive},
		{"headless --execute fails closed", false, true, true, authRecoveryFailClosed},
		{"concurrent never recovers", true, false, true, authRecoverySkip},
		{"concurrent+headless never recovers", true, true, true, authRecoverySkip},
		{"nothing needed", false, false, false, authRecoverySkip},
		{"headless but nothing needed", false, true, false, authRecoverySkip},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := decideAuthRecovery(tc.concurrent, tc.headless, tc.recovered); got != tc.want {
				t.Fatalf("decideAuthRecovery(%v,%v,%v) = %v, want %v",
					tc.concurrent, tc.headless, tc.recovered, got, tc.want)
			}
		})
	}
}

func TestShouldWriteServerAuth(t *testing.T) {
	auth := []byte(`{"auths":{"api.openai.com":{"token":"token"}}}`)
	cases := []struct {
		status string
		auth   []byte
		want   bool
	}{
		{"outdated", auth, true},
		{"updated", auth, true},
		{"missing", auth, true},
		{" UPDATED ", auth, true},
		{"valid", auth, true},
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

// TestApplyServerAuth pins the anti-clobber gates: a stale or known-bad server
// canonical must never overwrite a fresher local auth.json (the
// `codex login` → relaunch → clobbered failure), while a genuinely newer
// canonical still lands on disk.
func TestApplyServerAuth(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	freshStamp := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	staleStamp := time.Now().UTC().Add(-30 * 24 * time.Hour).Format(time.RFC3339)
	staleServerAuth := []byte(`{"last_refresh":"` + staleStamp + `","auths":{"api.openai.com":{"token":"stale"}}}`)
	freshServerAuth := []byte(`{"last_refresh":"` + freshStamp + `","auths":{"api.openai.com":{"token":"fresh"}}}`)

	writeLocal := func(t *testing.T, body string) string {
		t.Helper()
		p := filepath.Join(t.TempDir(), "auth.json")
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatalf("write local: %v", err)
		}
		return p
	}

	t.Run("stale server auth must not clobber fresher stamped local", func(t *testing.T) {
		local := writeLocal(t, `{"last_refresh":"`+freshStamp+`","tokens":{"access_token":"new"}}`)
		wrote, kept, err := applyServerAuth(logger, local, &orchestrator.AuthRetrieveResponse{
			Status: "outdated", Auth: staleServerAuth, CanonicalLastRefresh: staleStamp, VerificationState: "verified",
		}, false, codex.AuthGeneration{})
		if err != nil || wrote || !kept {
			t.Fatalf("wrote=%v kept=%v err=%v; want wrote=false kept=true", wrote, kept, err)
		}
		raw, _ := os.ReadFile(local)
		if !strings.Contains(string(raw), `"new"`) {
			t.Fatalf("local file was clobbered: %s", raw)
		}
	})

	t.Run("stale server auth must not clobber fresher vanilla-login local (mtime)", func(t *testing.T) {
		// Vanilla `codex login` output: no last_refresh — freshness comes from mtime.
		local := writeLocal(t, `{"tokens":{"access_token":"new"}}`)
		wrote, kept, err := applyServerAuth(logger, local, &orchestrator.AuthRetrieveResponse{
			Status: "outdated", Auth: staleServerAuth, CanonicalLastRefresh: staleStamp, VerificationState: "verified",
		}, false, codex.AuthGeneration{})
		if err != nil || wrote || !kept {
			t.Fatalf("wrote=%v kept=%v err=%v; want wrote=false kept=true", wrote, kept, err)
		}
	})

	t.Run("newer server auth still lands", func(t *testing.T) {
		local := writeLocal(t, `{"last_refresh":"`+staleStamp+`","tokens":{"access_token":"old"}}`)
		// Point codex.WriteAuth at the temp HOME so the test never touches ~/.codex.
		t.Setenv("HOME", filepath.Dir(filepath.Dir(local)))
		home, _ := os.UserHomeDir()
		if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o700); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		realPath, _ := codex.AuthPath()
		if err := os.WriteFile(realPath, []byte(`{"last_refresh":"`+staleStamp+`","tokens":{"access_token":"old"}}`), 0o600); err != nil {
			t.Fatalf("seed: %v", err)
		}
		expected, _ := codex.CurrentAuthGeneration()
		wrote, kept, err := applyServerAuth(logger, realPath, &orchestrator.AuthRetrieveResponse{
			Status: "outdated", Auth: freshServerAuth, CanonicalLastRefresh: freshStamp, VerificationState: "verified",
		}, false, expected)
		if err != nil || !wrote || kept {
			t.Fatalf("wrote=%v kept=%v err=%v; want wrote=true kept=false", wrote, kept, err)
		}
		raw, _ := os.ReadFile(realPath)
		if !strings.Contains(string(raw), `"fresh"`) {
			t.Fatalf("server auth not written: %s", raw)
		}
	})

	t.Run("failed verification blob is never written", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		home, _ := os.UserHomeDir()
		_ = os.MkdirAll(filepath.Join(home, ".codex"), 0o700)
		realPath, _ := codex.AuthPath()
		expected, _ := codex.CurrentAuthGeneration()
		wrote, kept, err := applyServerAuth(logger, realPath, &orchestrator.AuthRetrieveResponse{
			Status: "outdated", Auth: freshServerAuth, VerificationState: "failed",
		}, false, expected)
		if err != nil || wrote || kept {
			t.Fatalf("wrote=%v kept=%v err=%v; want both false", wrote, kept, err)
		}
		if _, err := os.Stat(realPath); !os.IsNotExist(err) {
			t.Fatalf("known-bad blob was materialized")
		}
	})

	t.Run("missing local file accepts server auth", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		home, _ := os.UserHomeDir()
		_ = os.MkdirAll(filepath.Join(home, ".codex"), 0o700)
		realPath, _ := codex.AuthPath()
		expected, _ := codex.CurrentAuthGeneration()
		wrote, kept, err := applyServerAuth(logger, realPath, &orchestrator.AuthRetrieveResponse{
			Status: "missing", Auth: freshServerAuth, VerificationState: "verified",
		}, false, expected)
		if err != nil || !wrote || kept {
			t.Fatalf("wrote=%v kept=%v err=%v; want wrote=true kept=false", wrote, kept, err)
		}
	})
}

func TestLocalAuthFresherThan(t *testing.T) {
	freshStamp := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	staleStamp := "2026-06-08T15:26:33Z"
	write := func(t *testing.T, body string) string {
		t.Helper()
		p := filepath.Join(t.TempDir(), "auth.json")
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		return p
	}
	if !localAuthFresherThan(write(t, `{"last_refresh":"`+freshStamp+`","tokens":{"access_token":"valid"}}`), []byte(`{"last_refresh":"`+staleStamp+`"}`)) {
		t.Fatalf("fresher stamped local must win over stale server payload")
	}
	if localAuthFresherThan(write(t, `{"last_refresh":"`+staleStamp+`","tokens":{"access_token":"valid"}}`), []byte(`{"last_refresh":"`+freshStamp+`"}`)) {
		t.Fatalf("older local must lose to fresher server payload")
	}
	if !localAuthFresherThan(write(t, `{"tokens":{"access_token":"native-login"}}`), []byte(`{"last_refresh":"`+staleStamp+`"}`)) {
		t.Fatalf("vanilla-login local (mtime=now) must win over stale server payload")
	}
	if !localAuthFresherThan(write(t, `{"last_refresh":"`+freshStamp+`","tokens":{"access_token":"valid"}}`), []byte(`{}`)) {
		t.Fatalf("server payload without a stamp must never win over an existing local")
	}
	if localAuthFresherThan(filepath.Join(t.TempDir(), "absent.json"), []byte(`{"last_refresh":"`+staleStamp+`"}`)) {
		t.Fatalf("missing local file is never fresher")
	}
	if localAuthFresherThan("", []byte(`{"last_refresh":"`+staleStamp+`"}`)) {
		t.Fatalf("empty path is never fresher")
	}
	if localAuthFresherThan(write(t, `{"last_refresh":"`+freshStamp+`","tokens":{}}`), []byte(`{"last_refresh":"`+staleStamp+`"}`)) {
		t.Fatalf("newer but invalid local auth must not block canonical healing")
	}
	if localAuthFresherThan(write(t, `{"last_refresh":"2099-01-01T00:00:00Z","tokens":{"access_token":"valid"}}`), []byte(`{"last_refresh":"`+staleStamp+`"}`)) {
		t.Fatalf("out-of-range local timestamp must not block canonical healing")
	}
}

func TestApplyServerAuthGenerationGuardKeepsLoginWrittenInFlight(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	old := []byte(`{"last_refresh":"2026-07-17T08:00:00Z","tokens":{"access_token":"old"}}`)
	if err := os.WriteFile(path, old, 0o600); err != nil {
		t.Fatal(err)
	}
	expected, _ := codex.CurrentAuthGeneration()
	login := []byte(`{"last_refresh":"2026-07-17T08:30:00Z","tokens":{"access_token":"login"}}`)
	if err := os.WriteFile(path, login, 0o600); err != nil {
		t.Fatal(err)
	}
	server := []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"server"}}`)
	wrote, kept, err := applyServerAuth(slog.Default(), path, &orchestrator.AuthRetrieveResponse{
		Status: "outdated", Auth: server, VerificationState: "verified",
	}, false, expected)
	if err != nil || wrote || !kept {
		t.Fatalf("applyServerAuth = wrote=%v kept=%v err=%v", wrote, kept, err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != string(login) {
		t.Fatalf("in-flight login clobbered: %s", raw)
	}
}

func TestConcurrentCanonicalResponsesConvergeToNewestInEitherOrder(t *testing.T) {
	base := time.Now().UTC()
	stamp := func(delta time.Duration) string { return base.Add(delta).Format(time.RFC3339Nano) }
	initial := []byte(`{"last_refresh":"` + stamp(-3*time.Hour) + `","tokens":{"access_token":"initial"}}`)
	older := []byte(`{"last_refresh":"` + stamp(-2*time.Hour) + `","tokens":{"access_token":"canonical-old"}}`)
	newer := []byte(`{"last_refresh":"` + stamp(-time.Hour) + `","tokens":{"access_token":"canonical-new"}}`)
	for _, tc := range []struct {
		name          string
		first, second []byte
	}{
		{name: "older response lands first", first: older, second: newer},
		{name: "newer response lands first", first: newer, second: older},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("CODEX_HOME", dir)
			path, _ := codex.AuthPath()
			if err := os.WriteFile(path, initial, 0o600); err != nil {
				t.Fatal(err)
			}
			expected, _ := codex.CurrentAuthGeneration()
			for _, payload := range [][]byte{tc.first, tc.second} {
				_, _, err := applyServerAuth(slog.Default(), path, &orchestrator.AuthRetrieveResponse{
					Status: "outdated", Auth: payload, VerificationState: "verified",
				}, false, expected)
				if err != nil {
					t.Fatal(err)
				}
			}
			raw, err := os.ReadFile(path)
			if err != nil || !strings.Contains(string(raw), `"access_token":"canonical-new"`) {
				t.Fatalf("final auth did not converge to newest: %s, %v", raw, err)
			}
		})
	}
}

func TestConcurrentCanonicalResponsesWithEqualFreshnessFailClosedInEitherOrder(t *testing.T) {
	stamp := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	initial := []byte(`{"last_refresh":"` + time.Now().UTC().Add(-2*time.Hour).Format(time.RFC3339Nano) + `","tokens":{"access_token":"initial"}}`)
	left := []byte(`{"last_refresh":"` + stamp + `","tokens":{"access_token":"canonical-left"}}`)
	right := []byte(`{"last_refresh":"` + stamp + `","tokens":{"access_token":"canonical-right"}}`)
	for _, tc := range []struct {
		name          string
		first, second []byte
	}{
		{name: "left response lands first", first: left, second: right},
		{name: "right response lands first", first: right, second: left},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("CODEX_HOME", dir)
			path, _ := codex.AuthPath()
			if err := os.WriteFile(path, initial, 0o600); err != nil {
				t.Fatal(err)
			}
			expected, _ := codex.CurrentAuthGeneration()
			if _, _, err := applyServerAuth(slog.Default(), path, &orchestrator.AuthRetrieveResponse{
				Status: "outdated", Auth: tc.first, VerificationState: "verified",
			}, false, expected); err != nil {
				t.Fatalf("first response: %v", err)
			}
			if _, _, err := applyServerAuth(slog.Default(), path, &orchestrator.AuthRetrieveResponse{
				Status: "outdated", Auth: tc.second, VerificationState: "verified",
			}, false, expected); !errors.Is(err, codex.ErrCanonicalAuthConflict) {
				t.Fatalf("second response error = %v, want equal-freshness conflict", err)
			}
			raw, err := os.ReadFile(path)
			if err != nil || string(raw) != string(tc.first) {
				t.Fatalf("first response was not preserved: %s, %v", raw, err)
			}
			if _, _, err := applyServerAuth(slog.Default(), path, &orchestrator.AuthRetrieveResponse{
				Status: "outdated", Auth: tc.first, VerificationState: "verified",
			}, false, expected); err != nil {
				t.Fatalf("exact duplicate response must be idempotent: %v", err)
			}
		})
	}
}

func TestApplyServerAuthHealsDefinitivelyRejectedNewerLocal(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	localStamp := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	serverStamp := time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339)
	rejected := []byte(`{"last_refresh":"` + localStamp + `","tokens":{"access_token":"provider-rejected"}}`)
	if err := os.WriteFile(path, rejected, 0o600); err != nil {
		t.Fatal(err)
	}
	expected, _ := codex.CurrentAuthGeneration()
	server := []byte(`{"last_refresh":"` + serverStamp + `","tokens":{"access_token":"healed"}}`)
	wrote, kept, err := applyServerAuth(slog.Default(), path, &orchestrator.AuthRetrieveResponse{
		Status: "outdated", Auth: server, VerificationState: "verified", CandidateRejectedDefinitive: true,
	}, false, expected)
	if err != nil || !wrote || kept {
		t.Fatalf("applyServerAuth = wrote=%v kept=%v err=%v", wrote, kept, err)
	}
	if !codex.IsValidLocalAuth(path) {
		t.Fatal("verified canonical did not heal invalid newer local auth")
	}
}

func TestApplyServerAuthDefinitiveSignalRequiresVerifiedCanonical(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	localStamp := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	serverStamp := time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339)
	local := []byte(`{"last_refresh":"` + localStamp + `","tokens":{"access_token":"local"}}`)
	if err := os.WriteFile(path, local, 0o600); err != nil {
		t.Fatal(err)
	}
	expected, _ := codex.CurrentAuthGeneration()
	server := []byte(`{"last_refresh":"` + serverStamp + `","tokens":{"access_token":"server"}}`)
	wrote, kept, err := applyServerAuth(slog.Default(), path, &orchestrator.AuthRetrieveResponse{
		Status: "outdated", Auth: server, CandidateRejectedDefinitive: true,
	}, false, expected)
	if err != nil || wrote || !kept {
		t.Fatalf("unverified override = wrote=%v kept=%v err=%v", wrote, kept, err)
	}
}

func TestApplyServerAuthExactCandidateSignalDoesNotGrantOverwrite(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	localStamp := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	serverStamp := time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339)
	local := []byte(`{"last_refresh":"` + localStamp + `","tokens":{"access_token":"local"}}`)
	if err := os.WriteFile(path, local, 0o600); err != nil {
		t.Fatal(err)
	}
	expected, _ := codex.CurrentAuthGeneration()
	server := []byte(`{"last_refresh":"` + serverStamp + `","tokens":{"access_token":"server"}}`)
	wrote, kept, err := applyServerAuth(slog.Default(), path, &orchestrator.AuthRetrieveResponse{
		Status:                      "outdated",
		Auth:                        server,
		VerificationState:           "verified",
		CandidateCredentialRejected: true,
	}, false, expected)
	if err != nil || wrote || !kept {
		t.Fatalf("exact-rejection-only overwrite = wrote=%v kept=%v err=%v", wrote, kept, err)
	}
	raw, readErr := os.ReadFile(path)
	if readErr != nil || string(raw) != string(local) {
		t.Fatalf("exact-rejection-only signal clobbered local auth: %s, %v", raw, readErr)
	}
}

func TestApplyServerAuthWritesRequiredCanonicalAlongsideActiveChild(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	expected, _ := codex.CurrentAuthGeneration()
	child, err := codex.AcquireActiveChild()
	if err != nil {
		t.Fatal(err)
	}
	defer child.Release()
	server := []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"required"}}`)
	wrote, kept, err := applyServerAuth(slog.Default(), path, &orchestrator.AuthRetrieveResponse{
		Status: "missing", Auth: server, VerificationState: "verified",
	}, false, expected)
	if err != nil || !wrote || kept {
		t.Fatalf("required write = wrote=%v kept=%v err=%v", wrote, kept, err)
	}
}

func TestApplyServerAuthReplacesUnchangedGenerationAlongsideActiveChild(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	local := []byte(`{"last_refresh":"2026-07-17T08:00:00Z","tokens":{"access_token":"still-valid-old"}}`)
	if err := os.WriteFile(path, local, 0o600); err != nil {
		t.Fatal(err)
	}
	expected, _ := codex.CurrentAuthGeneration()
	child, err := codex.AcquireActiveChild()
	if err != nil {
		t.Fatal(err)
	}
	defer child.Release()
	server := []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"required-newer"}}`)
	wrote, kept, err := applyServerAuth(slog.Default(), path, &orchestrator.AuthRetrieveResponse{
		Status: "outdated", Auth: server, VerificationState: "verified",
	}, false, expected)
	if err != nil || !wrote || kept {
		t.Fatalf("active-child unchanged generation = wrote=%v kept=%v err=%v", wrote, kept, err)
	}
	if raw, readErr := os.ReadFile(path); readErr != nil || !strings.Contains(string(raw), "required-newer") {
		t.Fatalf("canonical child generation missing: %q, %v", raw, readErr)
	}
}

func TestBootstrapOmitsInvalidJSONCandidateAndHealsFromCanonical(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	if err := os.WriteFile(path, []byte(`not-json`), 0o600); err != nil {
		t.Fatal(err)
	}
	candidateSeen := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode bundle request: %v", err)
		}
		_, candidateSeen = request["auth_candidate"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","auth":{"status":"outdated","verification_state":"verified","auth":{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"healed"}},"host":{"secure":true}}}`))
	}))
	defer server.Close()
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
	if err != nil {
		t.Fatal(err)
	}
	resp, authErr, synced, _, _, _ := bootstrap(context.Background(), client, slog.Default(), false, path)
	if authErr != nil || !synced || resp == nil {
		t.Fatalf("bootstrap = resp=%+v err=%v synced=%v", resp, authErr, synced)
	}
	if candidateSeen {
		t.Fatal("structurally invalid auth was sent as RawMessage candidate")
	}
	if raw, err := os.ReadFile(path); err != nil || !strings.Contains(string(raw), `"access_token":"healed"`) {
		t.Fatalf("canonical did not heal invalid JSON: %q, %v", raw, err)
	}
}

func TestBootstrapConcurrentRepairsUnusableAuthDespiteMatchingGenerationDigest(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, err := codex.AuthPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := codex.WriteAuth([]byte(`{"last_refresh":"2026-07-21T12:00:00Z","tokens":{"access_token":""}}`)); err != nil {
		t.Fatal(err)
	}
	seenEmptyDigest := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode bundle request: %v", err)
		}
		digest, sentDigest := request["auth_digest"]
		seenEmptyDigest = !sentDigest || string(digest) == `""`
		if _, ok := request["auth_candidate"]; ok {
			t.Error("unusable auth was sent as a candidate")
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/auth" {
			_, _ = w.Write([]byte(`{"status":"outdated","verification_state":"verified","auth":{"last_refresh":"2026-07-21T12:01:00Z","tokens":{"access_token":"healed"}},"host":{"secure":true}}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"ok","auth":{"status":"outdated","verification_state":"verified","auth":{"last_refresh":"2026-07-21T12:01:00Z","tokens":{"access_token":"healed"}},"host":{"secure":true}}}`))
	}))
	defer server.Close()
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
	if err != nil {
		t.Fatal(err)
	}
	resp, authErr, synced, _, _, _ := bootstrap(context.Background(), client, slog.Default(), true, path)
	if authErr != nil || !synced || resp == nil {
		t.Fatalf("concurrent unusable auth repair = resp=%+v synced=%v err=%v", resp, synced, authErr)
	}
	if !seenEmptyDigest {
		t.Fatal("unusable auth advertised a canonical digest instead of requesting repair")
	}
	if !codex.IsValidLocalAuth(path) {
		t.Fatal("concurrent canonical repair did not leave usable Codex credentials")
	}
	if err := codex.WriteAuth([]byte(`{"last_refresh":"2026-07-21T12:02:00Z","tokens":{"access_token":""}}`)); err != nil {
		t.Fatal(err)
	}
	seenEmptyDigest = false
	resp, legacyErr, synced := syncAuthLegacy(context.Background(), client, slog.Default(), true)
	if legacyErr != nil || !synced || resp == nil {
		t.Fatalf("concurrent legacy unusable auth repair = resp=%+v synced=%v err=%v", resp, synced, legacyErr)
	}
	if !seenEmptyDigest || !codex.IsValidLocalAuth(path) {
		t.Fatal("legacy concurrent repair did not request and restore usable Codex credentials")
	}
}

func TestLegacySyncTwoWayAuthConvergencePolicy(t *testing.T) {
	for _, tc := range []struct {
		name       string
		storeCode  int
		errorCode  string
		wantToken  string
		wantSynced bool
		wantUnsafe bool
	}{
		{name: "accepted newer candidate converges", storeCode: http.StatusOK, wantToken: "local", wantSynced: true},
		{name: "transient runner outage preserves newer local", storeCode: http.StatusServiceUnavailable, errorCode: "runner_unreachable", wantToken: "local"},
		{name: "security denial preserves newer local", storeCode: http.StatusForbidden, errorCode: "engine_disabled", wantToken: "local"},
		{name: "definitive validation rejection heals from verified canonical", storeCode: http.StatusUnprocessableEntity, errorCode: "validation_failed", wantToken: "canonical", wantSynced: true},
		{name: "unusable rotated runner writeback fails closed", storeCode: http.StatusServiceUnavailable, errorCode: "runner_updated_auth_invalid", wantToken: "local", wantUnsafe: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("CODEX_HOME", dir)
			path, _ := codex.AuthPath()
			localStamp := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
			canonicalStamp := time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339)
			local := json.RawMessage(`{"last_refresh":"` + localStamp + `","tokens":{"access_token":"local"}}`)
			canonical := json.RawMessage(`{"last_refresh":"` + canonicalStamp + `","tokens":{"access_token":"canonical"}}`)
			if err := os.WriteFile(path, local, 0o600); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					Command string          `json:"command"`
					Auth    json.RawMessage `json:"auth"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Errorf("decode request: %v", err)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				if request.Command == "retrieve" {
					_ = json.NewEncoder(w).Encode(map[string]any{
						"status": "outdated", "verification_state": "verified", "auth": canonical,
					})
					return
				}
				if tc.storeCode != http.StatusOK {
					w.WriteHeader(tc.storeCode)
					_ = json.NewEncoder(w).Encode(map[string]any{"code": tc.errorCode, "message": tc.errorCode})
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"status": "updated", "verification_state": "verified", "auth": request.Auth,
				})
			}))
			defer server.Close()
			client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
			if err != nil {
				t.Fatal(err)
			}
			resp, syncErr, synced := syncAuthLegacy(context.Background(), client, slog.Default(), false)
			if resp == nil {
				t.Fatal("legacy sync returned nil response")
			}
			if tc.wantUnsafe {
				if !orchestrator.IsUnsafeRunnerUpdatedAuthError(syncErr) {
					t.Fatalf("unsafe store error = %v", syncErr)
				}
				decision := decideAuth(resp, syncErr, path, true)
				if decision.Allowed || !strings.Contains(decision.Reason, "superseded") {
					t.Fatalf("unsafe runner writeback decision = %+v", decision)
				}
			} else if syncErr != nil {
				t.Fatalf("legacy sync error = %v", syncErr)
			}
			if synced != tc.wantSynced {
				t.Fatalf("synced = %v, want %v", synced, tc.wantSynced)
			}
			raw, err := os.ReadFile(path)
			if err != nil || !strings.Contains(string(raw), `"access_token":"`+tc.wantToken+`"`) {
				t.Fatalf("final auth = %s, %v; want %s", raw, err, tc.wantToken)
			}
		})
	}
}

func TestDecideAuthFailsOnCanonicalMaterializationErrorEvenWithOldLocal(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	if err := os.WriteFile(path, []byte(`{"last_refresh":"2026-07-17T08:00:00Z","tokens":{"access_token":"old"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	dec := decideAuth(
		&orchestrator.AuthRetrieveResponse{Status: "outdated"},
		&authMaterializationError{err: errors.New("disk full")},
		path,
		true,
	)
	if dec.Allowed || !strings.Contains(dec.Reason, "could not be written") {
		t.Fatalf("decision = %+v", dec)
	}
}

func TestPostRunChangedAuthFailureBecomesLifecycleFailure(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	before := []byte(`{"last_refresh":"2026-07-17T08:00:00Z","tokens":{"access_token":"old"}}`)
	if err := os.WriteFile(path, before, 0o600); err != nil {
		t.Fatal(err)
	}
	beforeHash, beforeRefresh := snapshotAuth(path)
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"rotated"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "runner unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	status, tone, postErr := maybePostRunAuthUpload(client, slog.Default(), path, beforeHash, beforeRefresh)
	if postErr == nil || status != "upload failed" || tone != ui.ToneFail {
		t.Fatalf("post-run = status=%q tone=%v err=%v", status, tone, postErr)
	}
	exit, merged := mergeLifecycleFailure(0, nil, postErr)
	if exit != 1 || merged == nil {
		t.Fatalf("mergeLifecycleFailure = %d, %v", exit, merged)
	}
}

func TestStoreCurrentAuthCandidateOutdatedDoesNotClearLogoutIntent(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
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
	client, _ := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
	resp, _, err := storeCurrentAuthCandidate(context.Background(), client, true)
	if err == nil || resp == nil || resp.Status != "outdated" {
		t.Fatalf("outdated store = resp=%+v err=%v", resp, err)
	}
	if active, err := codex.LogoutIntentActive(); err != nil || !active {
		t.Fatalf("outdated store erased logout intent: active=%v err=%v", active, err)
	}
}

func TestPostRunOutdatedStoreDoesNotAcknowledgeDeferredLogout(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	old := []byte(`{"last_refresh":"2026-07-17T09:00:00Z","tokens":{"access_token":"old"}}`)
	if err := os.WriteFile(path, old, 0o600); err != nil {
		t.Fatal(err)
	}
	beforeHash, beforeRefresh := snapshotAuth(path)
	oldGeneration, _ := codex.CurrentAuthGeneration()
	if marked, err := codex.MarkLogoutIntent(oldGeneration); err != nil || !marked {
		t.Fatalf("deferred logout = %v, %v", marked, err)
	}
	local := []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"new-login"}}`)
	if err := os.WriteFile(path, local, 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"outdated","verification_state":"verified","canonical_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","canonical_last_refresh":"2026-07-17T11:00:00Z","auth":{"last_refresh":"2026-07-17T11:00:00Z","tokens":{"access_token":"canonical"}},"host":{"secure":true}}`))
	}))
	defer server.Close()
	client, _ := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
	status, tone, postErr := maybePostRunAuthUpload(client, slog.Default(), path, beforeHash, beforeRefresh)
	if postErr == nil || status != "upload failed" || tone != ui.ToneFail {
		t.Fatalf("outdated post-run = status=%q tone=%v err=%v", status, tone, postErr)
	}
	if active, err := codex.LogoutIntentActive(); err != nil || !active {
		t.Fatalf("outdated post-run erased logout intent: active=%v err=%v", active, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(raw, local) {
		t.Fatalf("outdated post-run replaced logged-out generation: %q, %v", raw, err)
	}
}

func TestPostRunDifferentLoginClearsDeferredLogoutOnlyAfterStoreAcceptance(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	old := []byte(`{"last_refresh":"2026-07-17T09:00:00Z","tokens":{"access_token":"old"}}`)
	if err := os.WriteFile(path, old, 0o600); err != nil {
		t.Fatal(err)
	}
	beforeHash, beforeRefresh := snapshotAuth(path)
	oldGeneration, _ := codex.CurrentAuthGeneration()
	if marked, err := codex.MarkLogoutIntent(oldGeneration); err != nil || !marked {
		t.Fatalf("deferred logout = %v, %v", marked, err)
	}
	if err := os.WriteFile(path, []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"new-login"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified","host":{"secure":true}}`))
	}))
	defer server.Close()
	client, _ := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
	status, tone, err := maybePostRunAuthUpload(client, slog.Default(), path, beforeHash, beforeRefresh)
	if err != nil || status != "uploaded" || tone != ui.ToneOK || requests != 1 {
		t.Fatalf("post-run accepted login = status=%q tone=%v requests=%d err=%v", status, tone, requests, err)
	}
	if active, err := codex.LogoutIntentActive(); err != nil || active {
		t.Fatalf("accepted changed login left logout active=%v err=%v", active, err)
	}
}

func TestPostRunNativeLoginClockRollbackConvergesBeforeImmediateNextRun(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	xStamp := time.Now().UTC().Add(30 * time.Minute).Truncate(time.Microsecond)
	x := json.RawMessage(`{"last_refresh":"` + xStamp.Format(time.RFC3339Nano) + `","tokens":{"access_token":"native-x"}}`)
	expected, err := codex.CurrentAuthGeneration()
	if err != nil {
		t.Fatal(err)
	}
	if result, err := codex.ConvergeAuthIfCurrent(x, expected); err != nil || !result.Written {
		t.Fatalf("seed accepted X = %+v, %v", result, err)
	}
	beforeHash, beforeRefresh := snapshotAuth(path)

	// Native Codex writes Y without last_refresh after the host clock moved
	// backwards. The wrapper must derive Y from logical X, not the old mtime.
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"native-y"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	rolledBack := time.Now().UTC().Add(-24 * time.Hour)
	if err := os.Chtimes(path, rolledBack, rolledBack); err != nil {
		t.Fatal(err)
	}

	acceptedStamp := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/auth":
			var req struct {
				Command string          `json:"command"`
				Auth    json.RawMessage `json:"auth"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode post-run store: %v", err)
				return
			}
			candidateStamp, err := codex.LastRefreshFromRaw(req.Auth)
			if err != nil || req.Command != "store" || !strings.Contains(string(req.Auth), "native-y") {
				t.Errorf("post-run request = command %q auth %s stampErr=%v", req.Command, req.Auth, err)
				return
			}
			if !candidateStamp.After(xStamp) {
				_, _ = fmt.Fprintf(w, `{"status":"outdated","verification_state":"verified","canonical_last_refresh":%q,"auth":%s}`, xStamp.Format(time.RFC3339Nano), x)
				return
			}
			acceptedStamp = candidateStamp.Format(time.RFC3339Nano)
			_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified","host":{"secure":true}}`))
		case "/sync/bootstrap":
			var req orchestrator.BundleRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode immediate next bootstrap: %v", err)
				return
			}
			candidateStamp, err := codex.LastRefreshFromRaw(req.AuthCandidate)
			if err != nil || !strings.Contains(string(req.AuthCandidate), "native-y") || candidateStamp.Format(time.RFC3339Nano) != acceptedStamp {
				t.Errorf("immediate next cdx candidate=%s stamp=%s err=%v want=%s", req.AuthCandidate, candidateStamp, err, acceptedStamp)
			}
			_, _ = w.Write([]byte(`{"status":"ok","auth":{"status":"valid","verification_state":"verified","host":{"secure":true}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}

	status, tone, postErr := maybePostRunAuthUpload(client, logger, path, beforeHash, beforeRefresh)
	if postErr != nil || status != "uploaded" || tone != ui.ToneOK {
		t.Fatalf("post-run Y convergence = (%q,%v,%v)", status, tone, postErr)
	}
	if acceptedStamp == "" {
		t.Fatal("server never accepted monotonic Y generation")
	}
	resp, bootstrapErr, _, _, _, _ := bootstrap(context.Background(), client, logger, false, path)
	if bootstrapErr != nil || resp == nil || resp.Status != "valid" {
		t.Fatalf("immediate next cdx bootstrap = resp=%+v err=%v", resp, bootstrapErr)
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), "native-y") {
		t.Fatalf("immediate next cdx changed Y: %q err=%v", raw, err)
	}
	stamp, err := codex.LastRefreshFromRaw(raw)
	if err != nil || stamp.Format(time.RFC3339Nano) != acceptedStamp {
		t.Fatalf("immediate next cdx restamped Y: got %s err=%v want=%s", stamp, err, acceptedStamp)
	}
}

func TestBootstrapAuthCandidateSerializesConcurrentLogoutAcrossNetwork(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	if err := os.WriteFile(path, []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"candidate"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	expected, _ := codex.CurrentAuthGeneration()
	requestEntered := make(chan struct{})
	allowResponse := make(chan struct{})
	candidateSeen := make(chan bool, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode bootstrap: %v", err)
		}
		_, present := request["auth_candidate"]
		candidateSeen <- present
		close(requestEntered)
		<-allowResponse
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","auth":{"status":"valid","host":{"secure":true}}}`))
	}))
	defer server.Close()
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
	if err != nil {
		t.Fatal(err)
	}
	type result struct{ err error }
	done := make(chan result, 1)
	go func() {
		_, err, _, _, _, _ := bootstrap(context.Background(), client, slog.Default(), false, path)
		done <- result{err: err}
	}()
	select {
	case <-requestEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("bootstrap request did not start")
	}
	if !<-candidateSeen {
		t.Fatal("bootstrap test did not exercise inline auth_candidate persistence")
	}
	logoutDone := make(chan error, 1)
	go func() {
		marked, err := codex.MarkLogoutIntent(expected)
		if err == nil && !marked {
			err = errors.New("logout generation changed before store boundary")
		}
		logoutDone <- err
	}()
	select {
	case err := <-logoutDone:
		t.Fatalf("logout crossed in-flight bootstrap auth_candidate store: %v", err)
	case <-time.After(75 * time.Millisecond):
	}
	close(allowResponse)
	if got := <-done; got.err != nil {
		t.Fatal(got.err)
	}
	select {
	case err := <-logoutDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("logout did not commit after bootstrap store boundary released")
	}
	if active, err := codex.LogoutIntentActive(); err != nil || !active {
		t.Fatalf("later logout active=%v err=%v", active, err)
	}
}

func TestBootstrapOmitsAuthCandidateWhenLogoutAlreadyCommitted(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	if err := os.WriteFile(path, []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"logged-out"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	expected, _ := codex.CurrentAuthGeneration()
	if marked, err := codex.MarkLogoutIntent(expected); err != nil || !marked {
		t.Fatalf("mark logout = %v, %v", marked, err)
	}
	candidateSeen := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode bootstrap: %v", err)
		}
		_, candidateSeen = request["auth_candidate"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","auth":{"status":"missing","host":{"secure":true}}}`))
	}))
	defer server.Close()
	client, _ := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
	if _, err, _, _, _, _ := bootstrap(context.Background(), client, slog.Default(), false, path); err != nil {
		t.Fatal(err)
	}
	if candidateSeen {
		t.Fatal("bootstrap published an auth_candidate after explicit logout")
	}
}

func TestBootstrapClearsLogoutOnlyAfterDifferentLoginIsAccepted(t *testing.T) {
	for _, tc := range []struct {
		name       string
		auth       string
		reasons    string
		wantActive bool
	}{
		{
			name:       "accepted",
			auth:       `{"status":"updated","verification_state":"verified","host":{"secure":true}}`,
			reasons:    `,"reasons":["auth_stored"]`,
			wantActive: false,
		},
		{
			name:       "definitively rejected",
			auth:       `{"status":"outdated","verification_state":"verified","candidate_rejected_definitive":true,"auth":{"last_refresh":"2026-07-17T08:00:00Z","tokens":{"access_token":"canonical"}},"host":{"secure":true}}`,
			wantActive: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("CODEX_HOME", dir)
			path, _ := codex.AuthPath()
			if err := os.WriteFile(path, []byte(`{"last_refresh":"2026-07-17T09:00:00Z","tokens":{"access_token":"old"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			old, _ := codex.CurrentAuthGeneration()
			if marked, err := codex.MarkLogoutIntent(old); err != nil || !marked {
				t.Fatalf("mark logout = %v, %v", marked, err)
			}
			if err := os.WriteFile(path, []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"new-login"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			candidateSeen := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Errorf("decode bootstrap: %v", err)
				}
				_, candidateSeen = request["auth_candidate"]
				w.Header().Set("Content-Type", "application/json")
				_, _ = fmt.Fprintf(w, `{"status":"ok"%s,"auth":%s}`, tc.reasons, tc.auth)
			}))
			defer server.Close()
			client, _ := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
			_, bootstrapErr, _, _, _, _ := bootstrap(context.Background(), client, slog.Default(), false, path)
			if bootstrapErr != nil {
				t.Fatal(bootstrapErr)
			}
			if !candidateSeen {
				t.Fatal("different login was not offered for server acceptance")
			}
			active, err := codex.LogoutIntentActive()
			if err != nil || active != tc.wantActive {
				t.Fatalf("logout active=%v err=%v, want %v", active, err, tc.wantActive)
			}
		})
	}
}

func TestInsecurePurgeUsesLastSharedSessionLeaseInEitherExitOrder(t *testing.T) {
	for _, first := range []int{0, 1} {
		t.Run(fmt.Sprintf("lease-%d-exits-first", first), func(t *testing.T) {
			t.Setenv("CODEX_HOME", t.TempDir())
			path, _ := codex.AuthPath()
			if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"secret"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			leases := make([]*codex.AuthSession, 2)
			for i := range leases {
				var err error
				leases[i], err = codex.StartAuthSession(true)
				if err != nil {
					t.Fatal(err)
				}
			}
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			if err := finishAuthSession(logger, leases[first], first == 1); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("first exit purged auth while peer active: %v", err)
			}
			last := 1 - first
			if err := finishAuthSession(logger, leases[last], last == 1); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("last exit did not purge auth: %v", err)
			}
		})
	}
}

func TestFinishDoesNotReplayStaleSecureBootstrapAfterPostRunInsecureResponse(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := codex.AuthPath()
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"temporary"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	session, err := codex.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	if err := updateAuthSessionSecurity(&orchestrator.AuthRetrieveResponse{
		Status: "valid", Host: &orchestrator.HostInfo{Secure: true},
	}); err != nil {
		t.Fatal(err)
	}
	if err := updateAuthSessionSecurity(&orchestrator.AuthRetrieveResponse{Status: "insecure"}); err != nil {
		t.Fatal(err)
	}
	if err := finishAuthSession(slog.Default(), session, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale secure bootstrap replay canceled latest insecure purge: %v", err)
	}
}

func TestInsecurePurgeErrorCanForceNonzeroExit(t *testing.T) {
	base := t.TempDir()
	badHome := filepath.Join(base, "codex-home")
	t.Setenv("CODEX_HOME", badHome)
	lease, err := codex.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(badHome, badHome+"-moved"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(badHome, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	cleanupErr := finishAuthSession(slog.Default(), lease, false)
	if cleanupErr == nil {
		t.Fatal("expected insecure purge failure")
	}
	exit, merged := mergeLifecycleFailure(0, nil, cleanupErr)
	if exit != 1 || merged == nil {
		t.Fatalf("cleanup failure did not force nonzero: exit=%d err=%v", exit, merged)
	}
}

package lifecycle

import (
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ui"
)

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
			uploadErr: &orchestrator.HTTPError{StatusCode: 400, Method: "POST", Path: "/auth", Body: "candidate failed live verification"},
			want:      true,
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
			if got := needsInteractiveAuthRecovery(tc.decision, tc.uploadErr); got != tc.want {
				t.Fatalf("needsInteractiveAuthRecovery() = %v, want %v", got, tc.want)
			}
		})
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
		local := writeLocal(t, `{"last_refresh":"`+freshStamp+`","auths":{"api.openai.com":{"token":"new"}}}`)
		wrote, kept := applyServerAuth(logger, local, &orchestrator.AuthRetrieveResponse{
			Status: "outdated", Auth: staleServerAuth, CanonicalLastRefresh: staleStamp,
		}, false)
		if wrote || !kept {
			t.Fatalf("wrote=%v kept=%v; want wrote=false kept=true", wrote, kept)
		}
		raw, _ := os.ReadFile(local)
		if !strings.Contains(string(raw), `"new"`) {
			t.Fatalf("local file was clobbered: %s", raw)
		}
	})

	t.Run("stale server auth must not clobber fresher vanilla-login local (mtime)", func(t *testing.T) {
		// Vanilla `codex login` output: no last_refresh — freshness comes from mtime.
		local := writeLocal(t, `{"auths":{"api.openai.com":{"token":"new"}}}`)
		wrote, kept := applyServerAuth(logger, local, &orchestrator.AuthRetrieveResponse{
			Status: "outdated", Auth: staleServerAuth, CanonicalLastRefresh: staleStamp,
		}, false)
		if wrote || !kept {
			t.Fatalf("wrote=%v kept=%v; want wrote=false kept=true", wrote, kept)
		}
	})

	t.Run("newer server auth still lands", func(t *testing.T) {
		local := writeLocal(t, `{"last_refresh":"`+staleStamp+`","auths":{"api.openai.com":{"token":"old"}}}`)
		// Point codex.WriteAuth at the temp HOME so the test never touches ~/.codex.
		t.Setenv("HOME", filepath.Dir(filepath.Dir(local)))
		home, _ := os.UserHomeDir()
		if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o700); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		realPath, _ := codex.AuthPath()
		if err := os.WriteFile(realPath, []byte(`{"last_refresh":"`+staleStamp+`","auths":{"api.openai.com":{"token":"old"}}}`), 0o600); err != nil {
			t.Fatalf("seed: %v", err)
		}
		wrote, kept := applyServerAuth(logger, realPath, &orchestrator.AuthRetrieveResponse{
			Status: "outdated", Auth: freshServerAuth, CanonicalLastRefresh: freshStamp,
		}, false)
		if !wrote || kept {
			t.Fatalf("wrote=%v kept=%v; want wrote=true kept=false", wrote, kept)
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
		wrote, kept := applyServerAuth(logger, realPath, &orchestrator.AuthRetrieveResponse{
			Status: "outdated", Auth: freshServerAuth, VerificationState: "failed",
		}, false)
		if wrote || kept {
			t.Fatalf("wrote=%v kept=%v; want both false", wrote, kept)
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
		wrote, kept := applyServerAuth(logger, realPath, &orchestrator.AuthRetrieveResponse{
			Status: "missing", Auth: freshServerAuth,
		}, false)
		if !wrote || kept {
			t.Fatalf("wrote=%v kept=%v; want wrote=true kept=false", wrote, kept)
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
	if !localAuthFresherThan(write(t, `{"last_refresh":"`+freshStamp+`"}`), []byte(`{"last_refresh":"`+staleStamp+`"}`)) {
		t.Fatalf("fresher stamped local must win over stale server payload")
	}
	if localAuthFresherThan(write(t, `{"last_refresh":"`+staleStamp+`"}`), []byte(`{"last_refresh":"`+freshStamp+`"}`)) {
		t.Fatalf("older local must lose to fresher server payload")
	}
	if !localAuthFresherThan(write(t, `{"auths":{"x":{"token":"t"}}}`), []byte(`{"last_refresh":"`+staleStamp+`"}`)) {
		t.Fatalf("vanilla-login local (mtime=now) must win over stale server payload")
	}
	if !localAuthFresherThan(write(t, `{"last_refresh":"`+freshStamp+`"}`), []byte(`{}`)) {
		t.Fatalf("server payload without a stamp must never win over an existing local")
	}
	if localAuthFresherThan(filepath.Join(t.TempDir(), "absent.json"), []byte(`{"last_refresh":"`+staleStamp+`"}`)) {
		t.Fatalf("missing local file is never fresher")
	}
	if localAuthFresherThan("", []byte(`{"last_refresh":"`+staleStamp+`"}`)) {
		t.Fatalf("empty path is never fresher")
	}
}

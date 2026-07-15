package summary

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ui"
)

func TestBuildHidesOlderCodexTargetWhenExactIsFalse(t *testing.T) {
	withCodexVersion(t, "0.130.0")
	target := "0.129.0"
	got := Build(context.Background(), Inputs{
		Auth: &orchestrator.AuthRetrieveResponse{
			Versions: &orchestrator.VersionSummary{
				ClientVersion:             &target,
				ClientVersionEnforceExact: false,
			},
		},
	})

	if got.CodexTarget != "" {
		t.Fatalf("CodexTarget = %q, want empty", got.CodexTarget)
	}
	if got.CodexTone != ui.ToneOK {
		t.Fatalf("CodexTone = %q, want ok", got.CodexTone)
	}
}

func TestBuildShowsNewerCodexTargetWhenExactIsFalse(t *testing.T) {
	withCodexVersion(t, "0.129.0")
	target := "0.130.0"
	got := Build(context.Background(), Inputs{
		Auth: &orchestrator.AuthRetrieveResponse{
			Versions: &orchestrator.VersionSummary{
				ClientVersion:             &target,
				ClientVersionEnforceExact: false,
			},
		},
	})

	if got.CodexTarget != target {
		t.Fatalf("CodexTarget = %q, want %q", got.CodexTarget, target)
	}
	if got.CodexTone != ui.ToneWarn {
		t.Fatalf("CodexTone = %q, want warn", got.CodexTone)
	}
}

func TestBuildShowsOlderCodexTargetWhenExactIsTrue(t *testing.T) {
	withCodexVersion(t, "0.130.0")
	target := "0.129.0"
	got := Build(context.Background(), Inputs{
		Auth: &orchestrator.AuthRetrieveResponse{
			Versions: &orchestrator.VersionSummary{
				ClientVersion:             &target,
				ClientVersionEnforceExact: true,
			},
		},
	})

	if got.CodexTarget != target {
		t.Fatalf("CodexTarget = %q, want %q", got.CodexTarget, target)
	}
	if got.CodexTone != ui.ToneWarn {
		t.Fatalf("CodexTone = %q, want warn", got.CodexTone)
	}
}

func TestBuildMarksUnknownVersionsAsWarnings(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CDX_CODEX_BIN", filepath.Join(t.TempDir(), "missing-codex"))
	got := Build(context.Background(), Inputs{
		Auth: &orchestrator.AuthRetrieveResponse{Status: "valid"},
	})
	if got.CodexTone != ui.ToneWarn || got.WrapperTone != ui.ToneWarn || got.ResultTone != ui.ToneWarn {
		t.Fatalf("unknown versions rendered healthy: codex=%q wrapper=%q result=%q", got.CodexTone, got.WrapperTone, got.ResultTone)
	}
}

func TestBuildEscalatesHighQuotaToWarningOutcome(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	used, limit := 95, 100
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.44",
		Auth: &orchestrator.AuthRetrieveResponse{
			Status: "valid", QuotaLimitPercent: &limit,
			ChatGPT: &orchestrator.ChatGPTQuota{PrimaryUsed: &used},
		},
	})
	if got.QuotaWarn == "" || got.ResultTone != ui.ToneWarn {
		t.Fatalf("high quota did not drive the outcome: warn=%q result=%q", got.QuotaWarn, got.ResultTone)
	}
}

func TestBuildKeepsAdvisoryQuotaOverageLaunchable(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	used, limit := 100, 95
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.44",
		Auth: &orchestrator.AuthRetrieveResponse{
			Status: "valid", QuotaLimitPercent: &limit,
			ChatGPT: &orchestrator.ChatGPTQuota{PrimaryUsed: &used},
		},
	})
	if got.QuotaBlock != "" || got.QuotaWarn == "" || got.ResultTone != ui.ToneWarn {
		t.Fatalf("advisory overage was not reclassified: block=%q warn=%q result=%q", got.QuotaBlock, got.QuotaWarn, got.ResultTone)
	}
}

func TestBuildAdvisoryQuotaNeverDowngradesFailure(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	used, limit := 100, 95
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.44",
		AuthErr:        errors.New("sync exploded"),
		Auth: &orchestrator.AuthRetrieveResponse{
			Status: "valid", QuotaLimitPercent: &limit,
			ChatGPT: &orchestrator.ChatGPTQuota{PrimaryUsed: &used},
		},
	})
	if got.QuotaBlock != "" || got.QuotaWarn == "" || got.ResultTone != ui.ToneFail || got.ResultLabel != "Sync failed: sync exploded." {
		t.Fatalf("advisory quota hid failure: block=%q warn=%q result=%q label=%q", got.QuotaBlock, got.QuotaWarn, got.ResultTone, got.ResultLabel)
	}
}

func TestBuildHealthFailureOutranksQuotaWarning(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	used, limit := 90, 95
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.44",
		Auth: &orchestrator.AuthRetrieveResponse{
			Status: "invalid", QuotaLimitPercent: &limit,
			ChatGPT: &orchestrator.ChatGPTQuota{PrimaryUsed: &used},
		},
	})
	if got.QuotaWarn == "" || got.ResultTone != ui.ToneFail {
		t.Fatalf("health failure did not outrank quota warning: warn=%q result=%q", got.QuotaWarn, got.ResultTone)
	}
}

func TestBuildRetainsHardQuotaBlock(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	used, limit := 100, 95
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.44",
		Auth: &orchestrator.AuthRetrieveResponse{
			Status: "valid", QuotaHardFail: true, QuotaLimitPercent: &limit,
			ChatGPT: &orchestrator.ChatGPTQuota{PrimaryUsed: &used},
		},
	})
	if got.QuotaBlock == "" || got.ResultTone != ui.ToneFail {
		t.Fatalf("hard overage was not retained: block=%q result=%q", got.QuotaBlock, got.ResultTone)
	}
}

func TestBuildAuthToneReflectsWhetherCanonicalAuthWasApplied(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	for _, tc := range []struct {
		name       string
		authSynced bool
		wantTone   ui.Tone
		wantResult ui.Tone
	}{
		{name: "pending local write", wantTone: ui.ToneWarn, wantResult: ui.ToneWarn},
		{name: "written this run", authSynced: true, wantTone: ui.ToneOK, wantResult: ui.ToneOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Build(context.Background(), Inputs{
				WrapperVersion: "0.6.44",
				Auth:           &orchestrator.AuthRetrieveResponse{Status: "outdated"},
				AuthSynced:     tc.authSynced,
			})
			var authDot *ui.HealthDot
			for i := range got.Dots {
				if got.Dots[i].Name == "auth" {
					authDot = &got.Dots[i]
				}
			}
			if authDot == nil || authDot.Tone != tc.wantTone || authDot.Updated != tc.authSynced || got.ResultTone != tc.wantResult {
				t.Fatalf("auth/result state = dot=%+v result=%q, want tone=%q updated=%t result=%q", authDot, got.ResultTone, tc.wantTone, tc.authSynced, tc.wantResult)
			}
		})
	}
}

func TestBuildStatusOnlyHidesUnprobedResourceHealth(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	runner := "ok"
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.44",
		Auth:           &orchestrator.AuthRetrieveResponse{Status: "valid", Versions: &orchestrator.VersionSummary{RunnerState: &runner}},
		StatusOnly:     true,
	})
	for _, dot := range got.Dots {
		if dot.Name == "skills" || dot.Name == "config" {
			t.Fatalf("status presented unprobed resource as healthy: %+v", got.Dots)
		}
	}
	if len(got.Dots) != 3 {
		t.Fatalf("status health dots = %+v, want api/auth/runner", got.Dots)
	}
}

func TestBuildClassifiesQuotaProjectionTone(t *testing.T) {
	limit := 95
	for _, tc := range []struct {
		name       string
		used       int
		limitSec   int64
		resetAfter int64
		want       ui.Tone
	}{
		{name: "benign", used: 20, limitSec: 18_000, resetAfter: 9_000, want: ui.ToneDim},
		{name: "crosses limit", used: 50, limitSec: 18_000, resetAfter: 14_400, want: ui.ToneFail},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows, _, _ := buildQuota(&orchestrator.AuthRetrieveResponse{
				QuotaLimitPercent: &limit,
				ChatGPT: &orchestrator.ChatGPTQuota{
					PrimaryUsed:       &tc.used,
					PrimaryLimitSec:   &tc.limitSec,
					PrimaryResetAfter: &tc.resetAfter,
				},
			})
			if len(rows) != 1 || rows[0].Projection == "" || rows[0].ProjectionTone != tc.want {
				t.Fatalf("projection row = %+v, want one row with tone %q", rows, tc.want)
			}
		})
	}
}

func TestBuildTreatsUnknownRunnerStateAsWarning(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	runner := "future-state"
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.44",
		Auth:           &orchestrator.AuthRetrieveResponse{Status: "valid", Versions: &orchestrator.VersionSummary{RunnerState: &runner}},
	})
	for _, dot := range got.Dots {
		if dot.Name == "runner" && dot.Tone != ui.ToneWarn {
			t.Fatalf("unknown runner tone = %q, want warn", dot.Tone)
		}
	}
}

func withCodexVersion(t *testing.T, version string) {
	t.Helper()
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "codex")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho '"+version+"'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("CDX_CODEX_BIN", path)
}

func TestQuotaProjectionNoteShowsPercentAtReset(t *testing.T) {
	got := quotaProjectionNote(24, int64(5*3600), int64(2*3600+27*60))
	if got != "~47% at reset" {
		t.Fatalf("quotaProjectionNote() = %q, want %q", got, "~47% at reset")
	}
}

func TestQuotaProjectionNoteKeepsTimeToFullWhenCrossingLimit(t *testing.T) {
	got := quotaProjectionNote(50, int64(5*3600), int64(4*3600))
	if got != "~250% at reset; 100% in 1h" {
		t.Fatalf("quotaProjectionNote() = %q, want %q", got, "~250% at reset; 100% in 1h")
	}
}

func TestQuotaProjectionNoteSkipsFreshWindow(t *testing.T) {
	if got := quotaProjectionNote(5, int64(5*3600), int64(5*3600)); got != "" {
		t.Fatalf("quotaProjectionNote() = %q, want empty", got)
	}
}

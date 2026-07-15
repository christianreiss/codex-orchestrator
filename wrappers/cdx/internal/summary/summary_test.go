package summary

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
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
	if got.ResultLabel != "API and auth checks passed." {
		t.Fatalf("status verdict overclaims scope: %q", got.ResultLabel)
	}
}

func TestBuildFallsBackToLocalCodexPreferencesPerField(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "config.toml"), []byte("model = \"local-model\"\nmodel_reasoning_effort = \"local-effort\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	modelOverride := "wrapper-model"
	got := Build(context.Background(), Inputs{
		Config: &config.Config{EngineOptions: config.EngineOptions{ModelOverride: &modelOverride}},
		Auth: &orchestrator.AuthRetrieveResponse{Status: "valid", Host: &orchestrator.HostInfo{
			ReasoningEffort: "host-effort",
		}, ChatGPT: &orchestrator.ChatGPTQuota{ActiveLane: "normal"}},
	})
	if got.Model != "wrapper-model" || got.Effort != "host-effort" {
		t.Fatalf("override precedence = model %q effort %q", got.Model, got.Effort)
	}

	got = Build(context.Background(), Inputs{Auth: &orchestrator.AuthRetrieveResponse{Status: "valid"}})
	if got.Model != "local-model" || got.Effort != "local-effort" {
		t.Fatalf("local fallback = model %q effort %q", got.Model, got.Effort)
	}
}

func TestBuildShowsSparkLaunchEffortInsteadOfConfiguredFallback(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	t.Setenv("HOME", t.TempDir())
	auth := &orchestrator.AuthRetrieveResponse{Status: "valid", Host: &orchestrator.HostInfo{
		LanePreference:  "spark",
		ReasoningEffort: "ultra",
	}}
	got := Build(context.Background(), Inputs{Auth: auth})
	if got.Model != "gpt-5.3-codex-spark" || got.Effort != "high" {
		t.Fatalf("spark launch context = model %q effort %q", got.Model, got.Effort)
	}

	got = Build(context.Background(), Inputs{Auth: auth, LaunchArgs: []string{"--profile", "work"}})
	if got.Model != "profile:work" || got.Effort != "ultra" {
		t.Fatalf("explicit profile context = model %q effort %q", got.Model, got.Effort)
	}
}

func TestBuildResourceSyncHealthIsTruthful(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	for _, tc := range []struct {
		name        string
		state       ResourceSync
		concurrent  bool
		wantTone    ui.Tone
		wantUpdated bool
		wantResult  ui.Tone
	}{
		{name: "successful unchanged", state: ResourceSync{Checked: true}, wantTone: ui.ToneOK, wantResult: ui.ToneOK},
		{name: "successful updated", state: ResourceSync{Checked: true, Updated: true}, wantTone: ui.ToneOK, wantUpdated: true, wantResult: ui.ToneOK},
		{name: "best effort failure", state: ResourceSync{Checked: true, Err: errors.New("write failed")}, wantTone: ui.ToneWarn, wantResult: ui.ToneWarn},
		{name: "concurrent not attempted", concurrent: true, wantTone: ui.ToneDim, wantResult: ui.ToneOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Build(context.Background(), Inputs{
				WrapperVersion: "0.6.44",
				Auth:           &orchestrator.AuthRetrieveResponse{Status: "valid"},
				Concurrent:     tc.concurrent,
				SkillsSync:     tc.state,
				ConfigSync:     tc.state,
			})
			for _, name := range []string{"skills", "config"} {
				var found *ui.HealthDot
				for i := range got.Dots {
					if got.Dots[i].Name == name {
						found = &got.Dots[i]
					}
				}
				if found == nil || found.Tone != tc.wantTone || found.Updated != tc.wantUpdated {
					t.Fatalf("%s dot = %+v, want tone=%q updated=%t", name, found, tc.wantTone, tc.wantUpdated)
				}
			}
			if got.ResultTone != tc.wantResult {
				t.Fatalf("result = %q (%q), want %q", got.ResultLabel, got.ResultTone, tc.wantResult)
			}
			if tc.state.Err != nil && got.ResultLabel != "Attention — resource sync incomplete; launch continuing." {
				t.Fatalf("resource failure verdict = %q", got.ResultLabel)
			}
		})
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

func TestBuildQuotaDerivesLabelsFromProviderWindowDuration(t *testing.T) {
	used := 23
	limitSeconds := int64(7 * 24 * 60 * 60)
	resetAfter := int64(5 * 24 * 60 * 60)
	rows, _, _ := buildQuota(&orchestrator.AuthRetrieveResponse{
		ChatGPT: &orchestrator.ChatGPTQuota{
			PrimaryUsed:       &used,
			PrimaryLimitSec:   &limitSeconds,
			PrimaryResetAfter: &resetAfter,
		},
	})
	if len(rows) != 1 || rows[0].Label != "weekly" {
		t.Fatalf("quota rows = %+v, want provider-derived weekly label", rows)
	}
}

func TestBuildQuotaPreservesMeasuredZeroPercent(t *testing.T) {
	used := 0
	limitSeconds := int64(5 * 60 * 60)
	rows, _, _ := buildQuota(&orchestrator.AuthRetrieveResponse{
		ChatGPT: &orchestrator.ChatGPTQuota{PrimaryUsed: &used, PrimaryLimitSec: &limitSeconds},
	})
	if len(rows) != 1 || rows[0].Used != 0 || rows[0].Label != "5h" {
		t.Fatalf("zero-percent quota row was hidden: %+v", rows)
	}
}

func TestBuildQuotaUnknownResetNeverClaimsImminentReset(t *testing.T) {
	used, limit := 95, 100
	_, warn, _ := buildQuota(&orchestrator.AuthRetrieveResponse{
		QuotaLimitPercent: &limit,
		ChatGPT:           &orchestrator.ChatGPTQuota{PrimaryUsed: &used},
	})
	if warn != "5h quota high (95% used; reset unknown)" {
		t.Fatalf("quota warning = %q", warn)
	}

	used = 100
	_, _, block := buildQuota(&orchestrator.AuthRetrieveResponse{
		QuotaLimitPercent: &limit,
		ChatGPT:           &orchestrator.ChatGPTQuota{PrimaryUsed: &used},
	})
	if block != "5h quota reached (100% used; reset unknown)" {
		t.Fatalf("quota block = %q", block)
	}
}

func TestBuildQuotaKnownResetKeepsCountdown(t *testing.T) {
	used, limit := 95, 100
	resetAfter := int64(2 * 60 * 60)
	_, warn, _ := buildQuota(&orchestrator.AuthRetrieveResponse{
		QuotaLimitPercent: &limit,
		ChatGPT: &orchestrator.ChatGPTQuota{
			PrimaryUsed:       &used,
			PrimaryResetAfter: &resetAfter,
		},
	})
	if warn != "5h quota high (95% used; resets in 2h)" {
		t.Fatalf("quota warning = %q", warn)
	}
}

func TestBuildQuotaOnlyActiveLaneCanGateLaunch(t *testing.T) {
	normalUsed, sparkUsed, limit := 20, 100, 95
	providerReached := true
	for _, tc := range []struct {
		name      string
		lane      string
		wantBlock bool
	}{
		{name: "normal ignores exhausted spark", lane: "normal", wantBlock: false},
		{name: "spark enforces exhausted spark", lane: "spark", wantBlock: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, block := buildQuota(&orchestrator.AuthRetrieveResponse{
				Host:              &orchestrator.HostInfo{LanePreference: tc.lane},
				QuotaLimitPercent: &limit,
				ChatGPT: &orchestrator.ChatGPTQuota{
					PrimaryUsed:           &normalUsed,
					SparkPrimaryUsed:      &sparkUsed,
					SparkRateLimitReached: &providerReached,
				},
			})
			if (block != "") != tc.wantBlock {
				t.Fatalf("block = %q, wantBlock=%t", block, tc.wantBlock)
			}
		})
	}
}

func TestBuildQuotaProviderDeniedWithoutPercentageBlocksActiveLane(t *testing.T) {
	allowed := false
	_, _, block := buildQuota(&orchestrator.AuthRetrieveResponse{
		Host:    &orchestrator.HostInfo{LanePreference: "normal"},
		ChatGPT: &orchestrator.ChatGPTQuota{RateAllowed: &allowed},
	})
	if block != "normal lane quota reached (provider reported limit)" {
		t.Fatalf("provider block = %q", block)
	}
}

func TestBuildQuotaProviderRateLimitedStatusBlocksWithoutPercentage(t *testing.T) {
	_, _, block := buildQuota(&orchestrator.AuthRetrieveResponse{
		Host:    &orchestrator.HostInfo{LanePreference: "normal"},
		ChatGPT: &orchestrator.ChatGPTQuota{Status: "rate_limited"},
	})
	if block != "normal lane quota reached (provider reported limit)" {
		t.Fatalf("rate-limited provider block = %q", block)
	}
}

func TestBuildPromotesActiveForecastToAdvisoryOutcome(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	used, limit := 50, 95
	limitSeconds, resetAfter := int64(5*60*60), int64(4*60*60)
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.45",
		Auth: &orchestrator.AuthRetrieveResponse{
			Status:            "valid",
			QuotaLimitPercent: &limit,
			Host:              &orchestrator.HostInfo{LanePreference: "normal", Secure: true},
			ChatGPT: &orchestrator.ChatGPTQuota{
				PrimaryUsed:       &used,
				PrimaryLimitSec:   &limitSeconds,
				PrimaryResetAfter: &resetAfter,
			},
		},
	})
	if got.ResultTone != ui.ToneWarn || got.QuotaWarn == "" || got.QuotaBlock != "" {
		t.Fatalf("forecast did not become advisory: result=%q warn=%q block=%q", got.ResultTone, got.QuotaWarn, got.QuotaBlock)
	}
	if got.ResultLabel != "Quota forecast crosses the configured limit before reset." {
		t.Fatalf("forecast result = %q", got.ResultLabel)
	}
}

func TestBuildDoesNotAlarmOnNearFreshQuotaWindow(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	used, limit := 1, 95
	limitSeconds, resetAfter := int64(5*60*60), int64(5*60*60-1)
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.45",
		Auth: &orchestrator.AuthRetrieveResponse{
			Status:            "valid",
			QuotaLimitPercent: &limit,
			Host:              &orchestrator.HostInfo{LanePreference: "normal", Secure: true},
			ChatGPT: &orchestrator.ChatGPTQuota{
				PrimaryUsed:       &used,
				PrimaryLimitSec:   &limitSeconds,
				PrimaryResetAfter: &resetAfter,
			},
		},
	})
	if got.ResultTone != ui.ToneOK || got.QuotaWarn != "" || len(got.QuotaRows) != 1 || got.QuotaRows[0].Projection != "" {
		t.Fatalf("near-fresh quota produced a false alarm: %+v", got)
	}
}

func TestBuildIgnoresInactiveLaneForecastForOverallOutcome(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	normalUsed, sparkUsed, limit := 10, 50, 95
	limitSeconds, normalReset, sparkReset := int64(5*60*60), int64(60*60), int64(4*60*60)
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.45",
		Auth: &orchestrator.AuthRetrieveResponse{
			Status:            "valid",
			QuotaLimitPercent: &limit,
			Host:              &orchestrator.HostInfo{LanePreference: "normal", Secure: true},
			ChatGPT: &orchestrator.ChatGPTQuota{
				PrimaryUsed:            &normalUsed,
				PrimaryLimitSec:        &limitSeconds,
				PrimaryResetAfter:      &normalReset,
				SparkPrimaryUsed:       &sparkUsed,
				SparkPrimaryLimitSec:   &limitSeconds,
				SparkPrimaryResetAfter: &sparkReset,
			},
		},
	})
	if got.ResultTone != ui.ToneOK || got.QuotaWarn != "" || got.QuotaBlock != "" {
		t.Fatalf("inactive forecast altered outcome: result=%q warn=%q block=%q", got.ResultTone, got.QuotaWarn, got.QuotaBlock)
	}
}

func TestBuildQuotaUnavailableAndStaleTelemetryWarn(t *testing.T) {
	for _, tc := range []struct {
		name string
		q    orchestrator.ChatGPTQuota
		want string
	}{
		{name: "unavailable", q: orchestrator.ChatGPTQuota{Status: "unavailable"}, want: "ChatGPT quota telemetry unavailable"},
		{name: "stale", q: orchestrator.ChatGPTQuota{Status: "ok", FetchedAt: time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)}, want: "ChatGPT quota telemetry is stale"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, warn, _ := buildQuota(&orchestrator.AuthRetrieveResponse{ChatGPT: &tc.q})
			if warn != tc.want {
				t.Fatalf("telemetry warning = %q, want %q", warn, tc.want)
			}
		})
	}
}

func TestStaleQuotaTelemetryNeverGatesLaunch(t *testing.T) {
	used, limit := 100, 95
	allowed := false
	limitSeconds, resetAfter := int64(5*60*60), int64(4*60*60)
	stale := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	rows, warn, block := buildQuota(&orchestrator.AuthRetrieveResponse{
		QuotaLimitPercent: &limit,
		Host:              &orchestrator.HostInfo{LanePreference: "normal"},
		ChatGPT: &orchestrator.ChatGPTQuota{
			Status:            "ok",
			RateAllowed:       &allowed,
			PrimaryUsed:       &used,
			PrimaryLimitSec:   &limitSeconds,
			PrimaryResetAfter: &resetAfter,
			FetchedAt:         stale,
		},
	})
	if len(rows) != 1 || rows[0].Projection != "" {
		t.Fatalf("stale rows/projection = %+v", rows)
	}
	if warn != "ChatGPT quota telemetry is stale" || block != "" {
		t.Fatalf("stale quota outcome = warn %q, block %q", warn, block)
	}

	withCodexVersion(t, "0.144.1")
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.45",
		Auth: &orchestrator.AuthRetrieveResponse{
			Status:            "valid",
			QuotaHardFail:     true,
			QuotaLimitPercent: &limit,
			Host:              &orchestrator.HostInfo{Secure: true, LanePreference: "normal"},
			ChatGPT: &orchestrator.ChatGPTQuota{
				Status: "ok", RateAllowed: &allowed, PrimaryUsed: &used,
				PrimaryLimitSec: &limitSeconds, PrimaryResetAfter: &resetAfter, FetchedAt: stale,
			},
		},
	})
	if got.ResultTone != ui.ToneWarn || got.QuotaBlock != "" || got.ResultLabel != "Quota telemetry needs attention." {
		t.Fatalf("stale hard-fail state = tone %q, block %q, result %q", got.ResultTone, got.QuotaBlock, got.ResultLabel)
	}
}

func TestQuotaTelemetryWarningDoesNotClaimUsageIsHigh(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.45",
		Auth: &orchestrator.AuthRetrieveResponse{
			Status:  "valid",
			Host:    &orchestrator.HostInfo{Secure: true},
			ChatGPT: &orchestrator.ChatGPTQuota{Status: "unavailable"},
		},
	})
	if got.ResultTone != ui.ToneWarn || got.ResultLabel != "Quota telemetry needs attention." {
		t.Fatalf("telemetry outcome = %q %q", got.ResultTone, got.ResultLabel)
	}
	if strings.Contains(strings.ToLower(got.ResultLabel), "approach") {
		t.Fatalf("telemetry failure falsely claimed high usage: %q", got.ResultLabel)
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

func TestBuildRunnerFailureWarnsWithoutClaimingLaunchBlocked(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	runner := "fail"
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.45",
		Auth: &orchestrator.AuthRetrieveResponse{
			Status: "valid",
			Host:   &orchestrator.HostInfo{Secure: true},
			Versions: &orchestrator.VersionSummary{
				RunnerState: &runner,
			},
		},
	})
	for _, dot := range got.Dots {
		if dot.Name == "runner" && dot.Tone != ui.ToneWarn {
			t.Fatalf("failed runner tone = %q, want warning", dot.Tone)
		}
	}
	if got.ResultTone != ui.ToneWarn || strings.Contains(strings.ToLower(got.ResultLabel), "block") {
		t.Fatalf("failed runner result = %q %q", got.ResultTone, got.ResultLabel)
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
	if got := quotaProjectionNote(1, int64(5*3600), int64(5*3600)-1); got != "" {
		t.Fatalf("near-fresh quotaProjectionNote() = %q, want empty", got)
	}
}

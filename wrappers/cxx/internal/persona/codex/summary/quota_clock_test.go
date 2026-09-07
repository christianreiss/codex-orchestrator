package summary

import (
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func TestQuotaWindowClockAbsoluteResetOverridesRelative(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	fetched := now.Add(-20 * time.Minute).Format(time.RFC3339)
	relative, limit := int64(600), int64(18000)
	remaining, sample, stale, _ := quotaWindowClock(fetched, &relative, now.Add(time.Hour).Format(time.RFC3339), &limit, now)
	if stale || remaining != time.Hour || sample != 4800 {
		t.Fatalf("absolute clock = %s %d %v", remaining, sample, stale)
	}
	relative = 7200
	remaining, _, stale, _ = quotaWindowClock(fetched, &relative, now.Add(-time.Minute).Format(time.RFC3339), &limit, now)
	if !stale || remaining != 0 {
		t.Fatalf("past absolute clock ignored: %s %v", remaining, stale)
	}
}

func TestQuotaWindowClockAgesRelativeCountdownWithoutChangingProjectionSample(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	relative, limit := int64(7200), int64(18000)
	remaining, sample, stale, _ := quotaWindowClock(now.Add(-20*time.Minute).Format(time.RFC3339), &relative, "", &limit, now)
	if stale || remaining != 100*time.Minute || sample != 7200 {
		t.Fatalf("aged clock = %s %d %v", remaining, sample, stale)
	}
	remaining, sample, stale, note := quotaWindowClock("", nil, "", &limit, now)
	if stale || remaining != 0 || sample != 0 || note != "reset unknown" {
		t.Fatalf("unknown reset treated as expired: %s %d %v %q", remaining, sample, stale, note)
	}
}

func TestQuotaExpiredWindowNeverGatesAndOtherEvidenceSurvives(t *testing.T) {
	used, low, limit := 100, 10, 95
	allowed := false
	expired, current := int64(600), int64(7200)
	fetched := time.Now().Add(-20 * time.Minute).UTC().Format(time.RFC3339)
	for _, tc := range []struct {
		name                    string
		active                  string
		weekly                  *int
		provider, sparkProvider *bool
		wantBlock               bool
	}{
		{name: "expired percentage and provider flag", active: "normal", provider: &allowed},
		{name: "other current window below limit", active: "normal", weekly: &low, provider: &allowed},
		{name: "other current window at limit", active: "normal", weekly: &used, provider: &allowed, wantBlock: true},
		{name: "inactive expired window leaves active provider evidence", active: "spark", sparkProvider: &allowed, wantBlock: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows, warning, block := buildQuota(&orchestrator.AuthRetrieveResponse{QuotaLimitPercent: &limit, Host: &orchestrator.HostInfo{LanePreference: tc.active}, ChatGPT: &orchestrator.ChatGPTQuota{
				Status: "ok", FetchedAt: fetched, PrimaryUsed: &used, PrimaryResetAfter: &expired,
				SecondaryUsed: tc.weekly, SecondaryResetAfter: &current,
				RateAllowed: tc.provider, SparkRateAllowed: tc.sparkProvider,
			}})
			if len(rows) < 1 || !rows[0].Stale || rows[0].Projection != "" || rows[0].ResetAfter != 0 || (block != "") != tc.wantBlock {
				t.Fatalf("expired-window policy = %+v warn=%q block=%q", rows, warning, block)
			}
			if tc.active == "normal" && !tc.wantBlock && !strings.Contains(warning, "new report") {
				t.Fatalf("missing stale context: %q", warning)
			}
		})
	}
}

func TestQuotaUnknownResetRetainsCurrentPercentageGate(t *testing.T) {
	used, limit := 100, 95
	rows, _, block := buildQuota(&orchestrator.AuthRetrieveResponse{QuotaLimitPercent: &limit, ChatGPT: &orchestrator.ChatGPTQuota{Status: "ok", PrimaryUsed: &used}})
	if len(rows) != 1 || rows[0].Stale || rows[0].Projection != "" || block == "" || !strings.Contains(block, "reset unknown") {
		t.Fatalf("unknown reset removed valid quota evidence: %+v %q", rows, block)
	}
}

func TestQuotaExpiredResetWithoutPercentageDoesNotRetainProviderGate(t *testing.T) {
	allowed := false
	rows, warning, block := buildQuota(&orchestrator.AuthRetrieveResponse{ChatGPT: &orchestrator.ChatGPTQuota{
		Status: "rate_limited", FetchedAt: time.Now().Add(-time.Minute).Format(time.RFC3339), RateAllowed: &allowed,
		PrimaryResetAt: time.Now().Add(-time.Second).Format(time.RFC3339),
	}})
	if len(rows) != 0 || block != "" || !strings.Contains(warning, "new report") {
		t.Fatalf("expired provider-only report = %+v %q %q", rows, warning, block)
	}
}

func TestQuotaFutureObservationNeverGatesOrProjects(t *testing.T) {
	used, limit := 100, 95
	rows, warning, block := buildQuota(&orchestrator.AuthRetrieveResponse{QuotaLimitPercent: &limit, ChatGPT: &orchestrator.ChatGPTQuota{
		Status: "ok", PrimaryUsed: &used, FetchedAt: time.Now().Add(2 * time.Minute).Format(time.RFC3339),
	}})
	if len(rows) != 1 || !rows[0].Stale || block != "" || !strings.Contains(warning, "timestamp is invalid") {
		t.Fatalf("future observation acted current: %+v %q %q", rows, warning, block)
	}
}

func TestQuotaProjectionETAIsRelativeToNow(t *testing.T) {
	note := quotaProjectionNoteAt(50, 18000, 14400, 13800)
	if note != "~250% at reset; 100% in 50m" {
		t.Fatalf("prediction ETA did not age: %q", note)
	}
	if note := quotaProjectionNoteAt(50, 18000, 14400, 10000); note != "~250% at reset" {
		t.Fatalf("elapsed predicted ETA claimed a future countdown: %q", note)
	}
}

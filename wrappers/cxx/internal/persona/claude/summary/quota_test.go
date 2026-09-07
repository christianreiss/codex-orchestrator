package summary

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
)

func TestClaudeQuotaDecodesCanonicalAuthPayloadAndPreservesSparseZero(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	var auth orchestrator.AuthRetrieveResponse
	if err := json.Unmarshal([]byte(`{"status":"valid","claude_usage":{"status":"ok","source":"statusline","fetched_at":"2026-09-07T12:00:00Z","five_hour_used_percent":0,"five_hour_resets_at":"2026-09-07T13:00:00Z","seven_day_used_percent":null,"seven_day_resets_at":null,"five_hour_window":{"used_percent":0,"resets_at":"2026-09-07T13:00:00Z"},"seven_day_window":{"used_percent":null,"resets_at":null}}}`), &auth); err != nil {
		t.Fatal(err)
	}
	rows, warning := buildQuota(&auth, now)
	if warning != "" || len(rows) != 1 || rows[0].Used != 0 || rows[0].Label != "5h" || rows[0].ResetAfter != time.Hour || rows[0].Projection != "" || rows[0].Lane != "" || rows[0].Stale {
		t.Fatalf("canonical sparse report = rows %+v, warning %q", rows, warning)
	}
	for _, wire := range []string{`{"status":"valid"}`, `{"status":"valid","claude_usage":null}`} {
		var empty orchestrator.AuthRetrieveResponse
		if err := json.Unmarshal([]byte(wire), &empty); err != nil {
			t.Fatal(err)
		}
		if rows, warning := buildQuota(&empty, now); len(rows) != 0 || warning != "" {
			t.Fatalf("absent usage invented data: %+v %q", rows, warning)
		}
	}
}

func TestClaudeQuotaStaleReportsAreContextOnly(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	used := 100
	for _, tc := range []struct{ name, status, fetched string }{
		{"unavailable", "unavailable", now.Format(time.RFC3339)},
		{"stale", "ok", now.Add(-31 * time.Minute).Format(time.RFC3339)},
		{"missing time", "ok", ""},
		{"invalid time", "ok", "yesterday"},
		{"future time", "ok", now.Add(2 * time.Minute).Format(time.RFC3339)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows, warning := buildQuota(&orchestrator.AuthRetrieveResponse{ClaudeUsage: &orchestrator.ClaudeUsageSnapshot{
				Status: tc.status, FetchedAt: tc.fetched, FiveHourUsed: &used, FiveHourResetsAt: now.Add(time.Hour).Format(time.RFC3339),
			}}, now)
			if len(rows) != 1 || !rows[0].Stale || rows[0].Projection != "" || rows[0].Note == "" || warning == "" || strings.Contains(warning, "quota high") {
				t.Fatalf("stale quota acted current: %+v %q", rows, warning)
			}
		})
	}
}

func TestClaudeQuotaResetEvidence(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	used := 97
	for _, tc := range []struct {
		name, reset string
		stale       bool
	}{
		{"unknown", "", false},
		{"malformed", "0", false},
		{"expired", now.Add(-time.Second).Format(time.RFC3339), true},
		{"exact reset", now.Format(time.RFC3339), true},
		{"impossible window", now.Add(6 * time.Hour).Format(time.RFC3339), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows, warning := buildQuota(&orchestrator.AuthRetrieveResponse{ClaudeUsage: &orchestrator.ClaudeUsageSnapshot{
				Status: "ok", FetchedAt: now.Format(time.RFC3339), FiveHourUsed: &used, FiveHourResetsAt: tc.reset,
			}}, now)
			if len(rows) != 1 || rows[0].Stale != tc.stale || rows[0].Projection != "" || rows[0].ResetAfter != 0 || warning == "" {
				t.Fatalf("reset evidence = %+v %q", rows, warning)
			}
			if tc.stale && strings.Contains(warning, "quota high") {
				t.Fatalf("expired reading reported as current: %q", warning)
			}
		})
	}
}

func TestClaudeQuotaProjectionUsesObservationTime(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	fetched := now.Add(-10 * time.Minute)
	used := 50
	rows, warning := buildQuota(&orchestrator.AuthRetrieveResponse{ClaudeUsage: &orchestrator.ClaudeUsageSnapshot{
		Status: "ok", FetchedAt: fetched.Format(time.RFC3339), FiveHourUsed: &used, FiveHourResetsAt: fetched.Add(3 * time.Hour).Format(time.RFC3339),
	}}, now)
	if warning != "" || len(rows) != 1 || rows[0].Projection != "~125% at reset" || rows[0].ProjectionTone != ui.ToneWarn || rows[0].ResetAfter != 170*time.Minute {
		t.Fatalf("observation clock = %+v %q", rows, warning)
	}
}

func TestClaudeQuotaFirstSampleDoesNotInventTrend(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	used := 1
	rows, warning := buildQuota(&orchestrator.AuthRetrieveResponse{ClaudeUsage: &orchestrator.ClaudeUsageSnapshot{
		Status: "ok", FetchedAt: now.Format(time.RFC3339), FiveHourUsed: &used, FiveHourResetsAt: now.Add(5*time.Hour - time.Minute).Format(time.RFC3339),
		SevenDayUsed: &used, SevenDayResetsAt: now.Add(7*24*time.Hour - time.Hour).Format(time.RFC3339),
	}}, now)
	if len(rows) != 2 || warning != "" {
		t.Fatalf("first sample = %+v %q", rows, warning)
	}
	for _, row := range rows {
		if row.Projection != "" || row.Stale || row.Lane != "" {
			t.Fatalf("invented trend/lane: %+v", row)
		}
	}
}

func TestClaudeQuotaHighUsageRemainsAdvisoryUnderHardFail(t *testing.T) {
	withClaudeVersion(t, "2.1.206")
	used, limit := 97, 95
	got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", Auth: &orchestrator.AuthRetrieveResponse{
		Status: "valid", QuotaHardFail: true, QuotaLimitPercent: &limit,
		ClaudeUsage: &orchestrator.ClaudeUsageSnapshot{Status: "ok", FetchedAt: time.Now().Format(time.RFC3339), FiveHourUsed: &used},
	}})
	if got.QuotaBlock != "" || got.QuotaWarn == "" || got.ResultTone != ui.ToneWarn || !strings.Contains(got.QuotaWarn, "advisory only") || strings.Contains(got.ResultLabel, "blocked") {
		t.Fatalf("Claude quota refused launch: %+v", got)
	}
}

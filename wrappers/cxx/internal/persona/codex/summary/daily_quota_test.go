package summary

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func TestDailyPartitionDecodesAndEnforcesSamePolicy(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	for _, tc := range []struct {
		partition, used int
		hard, blocked   bool
		want            int
	}{
		{5, 20, true, true, 100}, {5, 19, true, false, 95}, {7, 15, true, true, 100}, {7, 15, false, false, 100}, {0, 30, true, false, -1},
	} {
		var auth orchestrator.AuthRetrieveResponse
		raw, _ := json.Marshal(map[string]any{"status": "valid", "quota_week_partition": tc.partition, "quota_hard_fail": tc.hard, "quota_limit_percent": 100, "chatgpt": map[string]any{"status": "ok", "daily_used_percent": tc.used, "fetched_at": time.Now().UTC().Format(time.RFC3339), "daily_baseline_at": time.Now().UTC().Format(time.RFC3339)}})
		if err := json.Unmarshal(raw, &auth); err != nil {
			t.Fatal(err)
		}
		got := Build(context.Background(), Inputs{Auth: &auth, WrapperVersion: "0.9.59"})
		if (got.QuotaBlock != "") != tc.blocked {
			t.Fatalf("%+v: block=%q warn=%q", tc, got.QuotaBlock, got.QuotaWarn)
		}
		found := -1
		for _, row := range got.QuotaRows {
			if row.Label == "daily" {
				found = row.Used
			}
		}
		if found != tc.want {
			t.Fatalf("%+v: rows=%+v", tc, got.QuotaRows)
		}
		if tc.partition != 0 && tc.used*tc.partition >= 90 && got.QuotaBlock == "" && got.QuotaWarn == "" {
			t.Fatal("advisory daily limit silent")
		}
	}
}
func TestDailyPartitionNeverInventsUsageOrOverridesOff(t *testing.T) {
	five, zero, used := 5, 0, 30
	for _, tc := range []struct {
		name string
		auth *orchestrator.AuthRetrieveResponse
	}{
		{"missing", &orchestrator.AuthRetrieveResponse{QuotaWeekPartition: &five, ChatGPT: &orchestrator.ChatGPTQuota{}}},
		{"stale", &orchestrator.AuthRetrieveResponse{QuotaWeekPartition: &five, ChatGPT: &orchestrator.ChatGPTQuota{DailyUsed: &used, FetchedAt: time.Now().Add(-time.Hour).Format(time.RFC3339)}}},
		{"previous-day", &orchestrator.AuthRetrieveResponse{QuotaWeekPartition: &five, ChatGPT: &orchestrator.ChatGPTQuota{DailyUsed: &used, DailyBaselineAt: time.Now().Add(-24 * time.Hour).Format(time.RFC3339)}}},
		{"explicit-off", &orchestrator.AuthRetrieveResponse{QuotaWeekPartition: &zero, ChatGPT: &orchestrator.ChatGPTQuota{DailyUsed: &used, WeekPart: &five}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows, warn, block := buildQuota(tc.auth)
			if block != "" {
				t.Fatal(block)
			}
			if tc.name == "missing" && (len(rows) != 0 || !strings.Contains(warn, "unavailable")) {
				t.Fatal(rows, warn)
			}
			if tc.name == "explicit-off" && len(rows) != 0 {
				t.Fatal(rows)
			}
		})
	}
}

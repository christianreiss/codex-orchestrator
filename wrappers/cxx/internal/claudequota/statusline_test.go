package claudequota

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// The confirmed real shape: read out of the installed
// @anthropic-ai/claude-code 2.1.235 binary via `strings` (see rawWindow's
// doc comment). `utilization` is already scaled 0-100 by the time Claude
// Code exposes it.
func TestExtractRateLimitsPrimaryFieldNames(t *testing.T) {
	payload := parsePayload([]byte(`{
		"rate_limits": {
			"five_hour": {"utilization": 41.6, "resets_at": "2026-08-19T18:00:00Z"},
			"seven_day": {"utilization": 12, "resets_at": "2026-08-24T00:00:00Z"}
		}
	}`))
	fiveHour, sevenDay := extractRateLimits(payload)
	if fiveHour == nil || fiveHour.UsedPercent != 41.6 || fiveHour.ResetsAt != "2026-08-19T18:00:00Z" {
		t.Fatalf("five_hour = %+v", fiveHour)
	}
	if sevenDay == nil || sevenDay.UsedPercent != 12 || sevenDay.ResetsAt != "2026-08-24T00:00:00Z" {
		t.Fatalf("seven_day = %+v", sevenDay)
	}
}

// used_percentage was this package's original (wrong) guess at the field
// name, sourced from secondhand community-tool inference rather than the
// real shipped code. Kept as a fallback purely in case some other code path
// or version exposes it; `utilization` is what actually ships.
func TestExtractRateLimitsUsedPercentageFallback(t *testing.T) {
	payload := parsePayload([]byte(`{
		"rate_limits": {
			"five_hour": {"used_percentage": 41.6, "resets_at": "2026-08-19T18:00:00Z"}
		}
	}`))
	fiveHour, _ := extractRateLimits(payload)
	if fiveHour == nil || fiveHour.UsedPercent != 41.6 {
		t.Fatalf("five_hour = %+v", fiveHour)
	}
}

func TestExtractRateLimitsFallbackFieldNames(t *testing.T) {
	// Defensive alt-spelling support: a schema drift must not silently stop
	// reporting a real number.
	payload := parsePayload([]byte(`{
		"rate_limits": {
			"five_hour": {"used_percent": 7, "reset_at": "2026-08-19T18:00:00Z"}
		}
	}`))
	fiveHour, sevenDay := extractRateLimits(payload)
	if fiveHour == nil || fiveHour.UsedPercent != 7 {
		t.Fatalf("five_hour = %+v", fiveHour)
	}
	if sevenDay != nil {
		t.Fatalf("seven_day should be absent, got %+v", sevenDay)
	}
}

func TestExtractRateLimitsAbsent(t *testing.T) {
	// An older Claude Code version, or a non-Pro/Max plan: no rate_limits
	// key at all. Must degrade to "nothing to report", never an error.
	payload := parsePayload([]byte(`{"model":{"display_name":"Sonnet 5"}}`))
	fiveHour, sevenDay := extractRateLimits(payload)
	if fiveHour != nil || sevenDay != nil {
		t.Fatalf("expected no windows, got fiveHour=%+v sevenDay=%+v", fiveHour, sevenDay)
	}
}

func TestExtractRateLimitsMalformedJSON(t *testing.T) {
	payload := parsePayload([]byte(`not json`))
	fiveHour, sevenDay := extractRateLimits(payload)
	if fiveHour != nil || sevenDay != nil {
		t.Fatalf("malformed payload must decode to no windows, got fiveHour=%+v sevenDay=%+v", fiveHour, sevenDay)
	}
}

func TestRenderStatusLineIncludesModelDirAndQuota(t *testing.T) {
	payload := parsePayload([]byte(`{
		"model": {"id": "claude-sonnet-5", "display_name": "Sonnet 5"},
		"workspace": {"current_dir": "/home/chris/Documents/codex-orchestrator"}
	}`))
	fiveHour := &reportWindow{UsedPercent: 41.6, ResetsAt: "x"}
	sevenDay := &reportWindow{UsedPercent: 12, ResetsAt: "y"}
	line := renderStatusLine(payload, fiveHour, sevenDay)
	if !strings.Contains(line, "Sonnet 5") {
		t.Errorf("expected model display name in %q", line)
	}
	if !strings.Contains(line, "codex-orchestrator") {
		t.Errorf("expected basename of current_dir in %q", line)
	}
	if !strings.Contains(line, "5h 42%") || !strings.Contains(line, "7d 12%") {
		t.Errorf("expected rounded quota segments in %q", line)
	}
}

func TestRenderStatusLineFallsBackToModelIDAndCwd(t *testing.T) {
	payload := parsePayload([]byte(`{"model":{"id":"claude-sonnet-5"},"cwd":"/some/project"}`))
	line := renderStatusLine(payload, nil, nil)
	if !strings.Contains(line, "claude-sonnet-5") || !strings.Contains(line, "project") {
		t.Errorf("expected id+cwd fallback in %q", line)
	}
}

func TestRenderStatusLineNeverEmpty(t *testing.T) {
	line := renderStatusLine(statusPayload{}, nil, nil)
	if strings.TrimSpace(line) == "" {
		t.Fatal("statusline must never be blank")
	}
}

func TestShouldReportOnFirstRun(t *testing.T) {
	if !shouldReport(nil, &reportWindow{UsedPercent: 1}, nil, time.Now()) {
		t.Fatal("first report must always fire")
	}
}

func TestShouldReportOnChangedPercent(t *testing.T) {
	state := &reportState{ReportedAt: time.Now().UTC().Format(time.RFC3339), FiveHourPercent: intPtr(5)}
	if !shouldReport(state, &reportWindow{UsedPercent: 6}, nil, time.Now()) {
		t.Fatal("a changed rounded percentage must report immediately, even inside the throttle window")
	}
}

func TestShouldReportSuppressedWithinThrottleWindowWhenUnchanged(t *testing.T) {
	state := &reportState{ReportedAt: time.Now().UTC().Format(time.RFC3339), FiveHourPercent: intPtr(5)}
	if shouldReport(state, &reportWindow{UsedPercent: 5}, nil, time.Now()) {
		t.Fatal("an unchanged percentage inside the throttle window must not report")
	}
}

func TestShouldReportFiresAfterThrottleWindowEvenUnchanged(t *testing.T) {
	old := time.Now().Add(-minReportInterval - time.Second)
	state := &reportState{ReportedAt: old.UTC().Format(time.RFC3339), FiveHourPercent: intPtr(5)}
	if !shouldReport(state, &reportWindow{UsedPercent: 5}, nil, time.Now()) {
		t.Fatal("an unchanged percentage past the throttle window must still heartbeat")
	}
}

func TestReportBodyOmitsAbsentWindows(t *testing.T) {
	body := reportBody(&reportWindow{UsedPercent: 5, ResetsAt: "r"}, nil)
	if _, ok := body["seven_day"]; ok {
		t.Error("seven_day must be omitted when absent, not sent as null/zero")
	}
	if _, ok := body["five_hour"]; !ok {
		t.Error("five_hour must be present")
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`"used_percent":5`)) {
		t.Errorf("expected used_percent in %s", raw)
	}
}

func TestRunCommandAlwaysPrintsAndNeverBlocksOnMissingConfig(t *testing.T) {
	stdin := strings.NewReader(`{
		"model": {"display_name": "Sonnet 5"},
		"workspace": {"current_dir": "/tmp/project"},
		"rate_limits": {"five_hour": {"utilization": 10, "resets_at": "x"}}
	}`)
	var stdout, stderr bytes.Buffer
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	code := RunCommand(stdin, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if !strings.Contains(stdout.String(), "Sonnet 5") {
		t.Errorf("stdout = %q", stdout.String())
	}
}

func intPtr(v int) *int { return &v }

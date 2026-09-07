package summary

import (
	"fmt"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
)

// Claude quotas are observations from Claude Code's statusline, never a
// provider probe. Keep the existing advisory launch policy: a report does not
// become a new local refusal simply because ChatGPT hard-fail is configured.
func buildQuota(auth *orchestrator.AuthRetrieveResponse, now time.Time) ([]ui.QuotaRow, string) {
	if auth == nil || auth.ClaudeUsage == nil {
		return nil, ""
	}
	q := auth.ClaudeUsage
	fetchedAt, freshnessWarning := quotaReportTime(q, now)
	limit := 100
	if auth.QuotaLimitPercent != nil {
		limit = max(50, min(100, *auth.QuotaLimitPercent))
	}
	warnAt := max(50, limit-10)
	var rows []ui.QuotaRow
	warning := freshnessWarning
	addWindow := func(label string, used *int, resetAtText string, window time.Duration) {
		if used == nil {
			return
		}
		if *used < 0 || *used > 100 {
			if warning == "" {
				warning = "Claude quota report contains an invalid percentage; run clx to report current usage."
			}
			return
		}
		row := ui.QuotaRow{Label: label, Used: *used, WarnAtPct: warnAt, BlockAtPct: limit}
		current := freshnessWarning == ""
		resetAt, resetErr := time.Parse(time.RFC3339, strings.TrimSpace(resetAtText))
		switch {
		case resetErr != nil:
			row.Note = "reset unknown"
		case !resetAt.After(now):
			current = false
			row.Note = "reset passed; awaiting host report"
			if warning == "" {
				warning = "Claude quota reset has passed; waiting for a new host report."
			}
		case resetAt.Sub(now) > window+time.Minute || (current && resetAt.Sub(fetchedAt) > window+time.Minute):
			current = false
			row.Note = "reset outside reported window"
			if warning == "" {
				warning = "Claude quota reset time is inconsistent; waiting for a new host report."
			}
		default:
			row.ResetAfter = resetAt.Sub(now)
		}
		if !current {
			row.Stale = true
			if row.Note == "" {
				row.Note = "last reported usage"
			}
		}
		if current && resetErr == nil && row.ResetAfter > 0 {
			// A cached percentage belongs to fetchedAt, not the current clock.
			// Extrapolating it as though just measured invents a slower burn rate.
			observedRemaining := int64(resetAt.Sub(fetchedAt) / time.Second)
			windowSeconds := int64(window / time.Second)
			if *used > 0 && ui.ProjectionReady(windowSeconds, observedRemaining) {
				projected := ui.ProjectUsage(*used, windowSeconds, observedRemaining)
				if projected > *used {
					row.Projection = fmt.Sprintf("~%d%% at reset", projected)
					row.ProjectionTone = ui.ToneDim
					if projected >= limit {
						row.ProjectionTone = ui.ToneWarn
					}
				}
			}
		}
		rows = append(rows, row)
		if current && *used >= warnAt && warning == "" {
			resetDetail := "; reset unknown"
			if row.ResetAfter > 0 {
				resetDetail = "; resets in " + ui.DurationShort(row.ResetAfter)
			}
			warning = fmt.Sprintf("Claude %s quota high (%d%% reported%s); advisory only.", label, *used, resetDetail)
		}
	}
	addWindow("5h", q.FiveHourUsed, q.FiveHourResetsAt, 5*time.Hour)
	addWindow("weekly", q.SevenDayUsed, q.SevenDayResetsAt, 7*24*time.Hour)
	return rows, warning
}

func quotaReportTime(q *orchestrator.ClaudeUsageSnapshot, now time.Time) (time.Time, string) {
	switch strings.ToLower(strings.TrimSpace(q.Status)) {
	case "error", "unavailable":
		return time.Time{}, "Claude quota telemetry unavailable; run clx to report current usage."
	}
	if strings.TrimSpace(q.FetchedAt) == "" {
		return time.Time{}, "Claude quota report time is unknown; showing last reported usage."
	}
	fetchedAt, err := time.Parse(time.RFC3339, strings.TrimSpace(q.FetchedAt))
	if err != nil || fetchedAt.After(now.Add(time.Minute)) {
		return time.Time{}, "Claude quota report timestamp is invalid; showing last reported usage."
	}
	if now.Sub(fetchedAt) > 30*time.Minute {
		return fetchedAt, "Claude quota telemetry is stale; showing last reported usage."
	}
	if fetchedAt.After(now) {
		fetchedAt = now
	}
	return fetchedAt, ""
}

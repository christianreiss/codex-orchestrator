// Package summary builds the ScreenInput for the cdx boot/status screen by
// combining the auth-retrieve response with locally-known state.
package summary

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ui"
)

// Inputs is what callers pass when building a screen state.
type Inputs struct {
	Config         *config.Config
	Auth           *orchestrator.AuthRetrieveResponse
	AuthErr        error
	Concurrent     bool
	ConcurrentNote string // override text for the "concurrent" boot-screen row

	// "updated this run" markers
	SkillsUpdated bool
	AgentsUpdated bool
	ConfigUpdated bool
	AuthSynced    bool
	// CodexUpdated holds the post-install codex version when the auto-update
	// path actually swapped the binary this run, empty otherwise. Surfaced as
	// a `● codex X.Y.Z` badge in the exit footer's Sync row.
	CodexUpdated string
	// Sessions carries the fleet-wide session counts the boot-screen
	// "sessions" block renders. Nil when the server didn't supply them
	// (older /sync/bootstrap response, offline mode, etc.) — the block is
	// then skipped entirely. LocalNow is computed wrapper-side.
	Sessions *SessionCounts
}

// SessionCounts is what the boot-screen "sessions" block needs. LocalNow is
// determined by walking /proc on the host; the rest are server-supplied
// fleet-wide aggregates.
type SessionCounts struct {
	LocalNow int64
	FleetNow int64
	Today    int64
	Month    int64
}

// Build converts the auth response + local state into a ScreenInput.
func Build(ctx context.Context, in Inputs) ui.ScreenInput {
	cfg := in.Config
	auth := in.Auth

	codexVer := codex.Version(ctx)
	codexTone := ui.ToneOK
	codexTarget := ""

	wrapperVer := ""
	if cfg != nil {
		wrapperVer = cfg.Wrapper.Version
	}
	wrapperTone := ui.ToneOK
	wrapperTarget := ""

	insecure := false
	if cfg != nil {
		insecure = !cfg.Host.Secure
	}
	fqdn := ""
	if cfg != nil {
		fqdn = cfg.Host.FQDN
	}

	var laneStr string
	var tokenSum int64
	var apiCalls int64
	var dots []ui.HealthDot
	var quotaRows []ui.QuotaRow
	var warnText, blockText string
	result := "Ready (Codex go brrrr)."
	resultTone := ui.ToneOK

	if auth != nil {
		if auth.Host != nil {
			insecure = !auth.Host.Secure
			laneStr = auth.Host.LanePreference
			apiCalls = auth.Host.APICalls
		}
		if auth.TokenUsageMonth != nil {
			tokenSum = auth.TokenUsageMonth.Total
		}
		if auth.APICalls > 0 {
			apiCalls = auth.APICalls
		}
		if auth.Versions != nil {
			if auth.Versions.ClientVersion != nil && codexVer != "" && codexVer != *auth.Versions.ClientVersion {
				codexTone = ui.ToneWarn
				codexTarget = *auth.Versions.ClientVersion
			}
			if auth.Versions.WrapperVersion != nil && wrapperVer != "" && wrapperVer != *auth.Versions.WrapperVersion {
				wrapperTone = ui.ToneWarn
				wrapperTarget = *auth.Versions.WrapperVersion
			}
		}

		dots = buildDots(auth, in)
		quotaRows, warnText, blockText = buildQuota(auth)
	} else {
		// No auth response — degrade.
		dots = []ui.HealthDot{
			{Name: "api", Tone: ui.ToneFail},
			{Name: "auth", Tone: ui.ToneFail},
		}
		result = "API unreachable; see `cdx doctor`."
		resultTone = ui.ToneFail
	}

	if in.AuthErr != nil {
		result = fmt.Sprintf("Sync failed: %s.", in.AuthErr.Error())
		resultTone = ui.ToneFail
	} else if insecure {
		result = "Ready on insecure host."
		resultTone = ui.ToneWarn
	}
	if blockText != "" {
		result = "Quota blocked; refusing to launch unless QUOTA_HARD_FAIL=0."
		resultTone = ui.ToneFail
	}

	theme := ""
	if cfg != nil && cfg.EngineOptions.AdminThemeHint != nil {
		theme = *cfg.EngineOptions.AdminThemeHint
	}

	return ui.ScreenInput{
		WrapperVersion: wrapperVer,
		WrapperTone:    wrapperTone,
		WrapperTarget:  wrapperTarget,
		CodexVersion:   codexVer,
		CodexTone:      codexTone,
		CodexTarget:    codexTarget,
		HostFQDN:       fqdn,
		Insecure:       insecure,
		Lane:           laneStr,
		TokenSum:       tokenSum,
		APICalls:       apiCalls,
		Concurrent:     in.Concurrent,
		ConcurrentNote: in.ConcurrentNote,
		Dots:           dots,
		QuotaRows:      quotaRows,
		QuotaWarn:      warnText,
		QuotaBlock:     blockText,
		SessionRows:    sessionRows(in.Sessions),
		ResultLabel:    result,
		ResultTone:     resultTone,
		Theme:          theme,
	}
}

// sessionRows turns the per-run SessionCounts struct into the labeled rows
// the boot-screen renderer expects. Returns nil when the server omitted the
// fleet block (legacy server / offline / etc.) so the screen renderer skips
// the entire section.
func sessionRows(s *SessionCounts) []ui.SessionRow {
	if s == nil {
		return nil
	}
	return []ui.SessionRow{
		{Label: "local now", Count: s.LocalNow},
		{Label: "fleet now", Count: s.FleetNow},
		{Label: "today", Count: s.Today},
		{Label: "month", Count: s.Month},
	}
}

func buildDots(auth *orchestrator.AuthRetrieveResponse, in Inputs) []ui.HealthDot {
	apiTone := ui.ToneOK
	if auth.Status == "" || auth.Status == "error" {
		apiTone = ui.ToneFail
	}

	authTone := ui.ToneOK
	switch strings.ToLower(auth.Status) {
	case "valid", "ok", "current", "unchanged", "updated":
		authTone = ui.ToneOK
	case "outdated":
		authTone = ui.ToneOK
	case "missing", "upload_required":
		authTone = ui.ToneWarn
	case "disabled", "invalid", "insecure-denied":
		authTone = ui.ToneFail
	case "insecure":
		authTone = ui.ToneWarn
	}

	skillsTone := ui.ToneOK
	mcpTone := ui.ToneOK

	dots := []ui.HealthDot{
		{Name: "api", Tone: apiTone},
		{Name: "auth", Tone: authTone, Updated: in.AuthSynced || strings.EqualFold(auth.Status, "outdated") || strings.EqualFold(auth.Status, "updated")},
		{Name: "skills", Tone: skillsTone, Updated: in.SkillsUpdated},
		{Name: "mcp", Tone: mcpTone, Updated: in.ConfigUpdated || in.AgentsUpdated},
	}
	if auth.Versions != nil && auth.Versions.RunnerState != nil {
		rt := ui.ToneOK
		switch *auth.Versions.RunnerState {
		case "ok", "fresh", "verified":
			rt = ui.ToneOK
		case "stale":
			rt = ui.ToneWarn
		case "fail", "broken", "":
			rt = ui.ToneFail
		}
		dots = append(dots, ui.HealthDot{Name: "runner", Tone: rt})
	}
	return dots
}

func buildQuota(auth *orchestrator.AuthRetrieveResponse) ([]ui.QuotaRow, string, string) {
	q := auth.ChatGPT
	if q == nil {
		return nil, "", ""
	}
	rows := []ui.QuotaRow{}
	limitPct := 100
	if auth.QuotaLimitPercent != nil {
		limitPct = *auth.QuotaLimitPercent
	}
	warnAt := limitPct - 10
	if warnAt < 50 {
		warnAt = 50
	}

	var warnText, blockText string
	addRow := func(label string, used *int, lim, resetAfter *int64, lane string) {
		if used == nil || *used <= 0 {
			return
		}
		row := ui.QuotaRow{
			Label:      label,
			Used:       *used,
			Lane:       lane,
			WarnAtPct:  warnAt,
			BlockAtPct: limitPct,
		}
		if resetAfter != nil && *resetAfter > 0 {
			row.ResetAfter = time.Duration(*resetAfter) * time.Second
		}
		var resetSec int64
		if resetAfter != nil {
			resetSec = *resetAfter
		}
		var limSec int64
		if lim != nil {
			limSec = *lim
		}
		eta := ui.ProjectETA(*used, limSec, resetSec)
		if eta > 0 {
			row.Projection = fmt.Sprintf("~100%% in %s, before reset", ui.DurationShort(eta))
		}
		rows = append(rows, row)

		if *used >= limitPct && blockText == "" {
			blockText = fmt.Sprintf("%s quota reached (%d%% used; resets in %s)", strings.TrimSpace(label), *used, ui.DurationShort(row.ResetAfter))
		} else if *used >= warnAt && warnText == "" {
			warnText = fmt.Sprintf("%s quota high (%d%% used; resets in %s)", strings.TrimSpace(label), *used, ui.DurationShort(row.ResetAfter))
		}
	}

	addRow("5h     ", q.PrimaryUsed, q.PrimaryLimitSec, q.PrimaryResetAfter, "normal")
	addRow("weekly ", q.SecondaryUsed, q.SecondaryLimitSec, q.SecondaryResetAfter, "normal")
	addRow("⚡ 5h   ", q.SparkPrimaryUsed, q.SparkPrimaryLimitSec, q.SparkPrimaryResetAfter, "spark")
	addRow("⚡ week ", q.SparkSecondaryUsed, q.SparkSecondaryLimitSec, q.SparkSecondaryResetAfter, "spark")

	if strings.EqualFold(q.Status, "limit_reached") {
		blockText = "ChatGPT status limit_reached"
	}
	return rows, warnText, blockText
}

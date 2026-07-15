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
	WrapperVersion string
	Auth           *orchestrator.AuthRetrieveResponse
	AuthErr        error
	Concurrent     bool
	ConcurrentNote string // override text for the "concurrent" boot-screen row

	// "updated this run" markers
	SkillsUpdated bool
	AgentsUpdated bool
	ConfigUpdated bool
	AuthSynced    bool
	// StatusOnly suppresses resource-sync markers because `cdx status` probes
	// /auth only and must not present unprobed skills/config as healthy.
	StatusOnly bool
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
	if unknownVersion(codexVer) {
		codexTone = ui.ToneWarn
	}
	codexTarget := ""

	wrapperVer := ""
	if in.WrapperVersion != "" {
		wrapperVer = in.WrapperVersion
	} else if cfg != nil {
		wrapperVer = cfg.Wrapper.Version
	}
	wrapperTone := ui.ToneOK
	if unknownVersion(wrapperVer) {
		wrapperTone = ui.ToneWarn
	}
	wrapperTarget := ""

	insecure := false
	browserOS := false
	if cfg != nil {
		insecure = !cfg.Host.Secure
		browserOS = cfg.Host.BrowserOSMCPEnabled
	}
	fqdn := ""
	model := ""
	effort := ""
	if cfg != nil {
		fqdn = cfg.Host.FQDN
		if cfg.EngineOptions.ModelOverride != nil {
			model = strings.TrimSpace(*cfg.EngineOptions.ModelOverride)
		}
		if cfg.EngineOptions.ReasoningEffortOverride != nil {
			effort = strings.TrimSpace(*cfg.EngineOptions.ReasoningEffortOverride)
		}
	}

	var laneStr string
	var apiCalls int64
	var dots []ui.HealthDot
	var quotaRows []ui.QuotaRow
	var warnText, blockText string
	result := "Ready — all systems operational."
	resultTone := ui.ToneOK

	if auth != nil {
		if auth.Host != nil {
			insecure = !auth.Host.Secure
			browserOS = auth.Host.BrowserOSMCPEnabled
			laneStr = auth.Host.LanePreference
			apiCalls = auth.Host.APICalls
			if strings.TrimSpace(auth.Host.ModelOverride) != "" {
				model = strings.TrimSpace(auth.Host.ModelOverride)
			}
			if strings.TrimSpace(auth.Host.ReasoningEffort) != "" {
				effort = strings.TrimSpace(auth.Host.ReasoningEffort)
			}
		}
		if auth.APICalls > 0 {
			apiCalls = auth.APICalls
		}
		if auth.Versions != nil {
			if target := clientTarget(auth.Versions); shouldShowClientTarget(codexVer, target, auth.Versions.ClientVersionEnforceExact) {
				codexTone = ui.ToneWarn
				codexTarget = target
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
		result = "API unreachable; run `cdx doctor`."
		resultTone = ui.ToneFail
	}

	if in.AuthErr != nil {
		result = fmt.Sprintf("Sync failed: %s.", in.AuthErr.Error())
		resultTone = ui.ToneFail
	} else if insecure {
		if in.AuthSynced {
			result = "Synced on insecure host; auth refreshed."
		} else {
			result = "Ready on insecure host."
		}
		resultTone = ui.ToneWarn
	}
	if blockText != "" {
		if auth != nil && auth.QuotaHardFail {
			result = "Quota blocked; refusing to launch unless QUOTA_HARD_FAIL=0."
			resultTone = ui.ToneFail
		} else {
			warnText = blockText
			blockText = ""
			if resultTone != ui.ToneFail {
				result = "Quota limit reached (advisory only; launch not blocked)."
				resultTone = ui.ToneWarn
			}
		}
	} else if warnText != "" && resultTone == ui.ToneOK {
		result = "Quota is approaching the configured limit."
		resultTone = ui.ToneWarn
	}
	worst := worstTone(dots, codexTone, wrapperTone)
	switch worst {
	case ui.ToneFail:
		if resultTone != ui.ToneFail {
			result = "Attention required; run `cdx doctor`."
			resultTone = ui.ToneFail
		}
	case ui.ToneWarn:
		if resultTone == ui.ToneOK {
			result = "Ready with warnings; run `cdx doctor` for details."
			resultTone = ui.ToneWarn
		}
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
		BrowserOS:      browserOS,
		Model:          model,
		Effort:         effort,
		Lane:           laneStr,
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

func clientTarget(v *orchestrator.VersionSummary) string {
	if v == nil {
		return ""
	}
	if v.ClientVersionOverride != nil && strings.TrimSpace(*v.ClientVersionOverride) != "" {
		return strings.TrimSpace(*v.ClientVersionOverride)
	}
	if v.ClientVersion != nil {
		return strings.TrimSpace(*v.ClientVersion)
	}
	return ""
}

func shouldShowClientTarget(current, target string, enforceExact bool) bool {
	current = strings.TrimSpace(current)
	target = strings.TrimSpace(target)
	if target == "" || target == "latest" || current == target {
		return false
	}
	if current == "" || current == "unknown" {
		return true
	}
	if enforceExact {
		return true
	}
	return codex.SemverGT(target, current)
}

func unknownVersion(version string) bool {
	version = strings.TrimSpace(version)
	return version == "" || strings.EqualFold(version, "unknown")
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
	if auth.Status == "" || auth.Status == "error" || auth.Status == "offline" {
		apiTone = ui.ToneFail
	}

	authTone := ui.ToneOK
	switch strings.ToLower(auth.Status) {
	case "valid", "ok", "current", "unchanged":
		authTone = ui.ToneOK
	case "outdated", "updated":
		if in.AuthSynced {
			authTone = ui.ToneOK
		} else {
			authTone = ui.ToneWarn
		}
	case "missing", "upload_required":
		authTone = ui.ToneWarn
	case "disabled", "invalid", "insecure-denied":
		authTone = ui.ToneFail
	case "insecure":
		authTone = ui.ToneWarn
	default:
		// Fail closed: "offline"/"error"/"" and any status this wrapper
		// doesn't recognize yet must not render as a healthy green dot,
		// mirroring the RunnerState default-fail handling below.
		authTone = ui.ToneFail
	}
	// A live-verification failure overrides the digest-derived tone: the token
	// the host would launch with does not authenticate, so the dot must read red
	// even when the digest status alone looked green.
	if strings.EqualFold(strings.TrimSpace(auth.VerificationState), "failed") {
		authTone = ui.ToneFail
	}

	skillsTone := ui.ToneOK
	mcpTone := ui.ToneOK

	dots := []ui.HealthDot{
		{Name: "api", Tone: apiTone},
		{Name: "auth", Tone: authTone, Updated: in.AuthSynced},
	}
	if !in.StatusOnly {
		dots = append(dots,
			ui.HealthDot{Name: "skills", Tone: skillsTone, Updated: in.SkillsUpdated},
			ui.HealthDot{Name: "config", Tone: mcpTone, Updated: in.ConfigUpdated || in.AgentsUpdated},
		)
	}
	if auth.Versions != nil && auth.Versions.RunnerState != nil {
		rt := ui.ToneOK
		switch strings.ToLower(strings.TrimSpace(*auth.Versions.RunnerState)) {
		case "ok", "fresh", "verified":
			rt = ui.ToneOK
		case "stale":
			rt = ui.ToneWarn
		case "fail", "broken", "":
			rt = ui.ToneFail
		default:
			rt = ui.ToneWarn
		}
		dots = append(dots, ui.HealthDot{Name: "runner", Tone: rt})
	}
	return dots
}

func worstTone(dots []ui.HealthDot, extra ...ui.Tone) ui.Tone {
	worst := ui.ToneOK
	visit := func(t ui.Tone) {
		switch t {
		case ui.ToneFail:
			worst = ui.ToneFail
		case ui.ToneWarn:
			if worst != ui.ToneFail {
				worst = ui.ToneWarn
			}
		}
	}
	for _, dot := range dots {
		visit(dot.Tone)
	}
	for _, tone := range extra {
		visit(tone)
	}
	return worst
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
		row.Projection = quotaProjectionNote(*used, limSec, resetSec)
		if row.Projection != "" {
			row.ProjectionTone = ui.ToneDim
			projected := ui.ProjectUsage(*used, limSec, resetSec)
			if projected >= limitPct {
				row.ProjectionTone = ui.ToneFail
			} else if projected >= warnAt {
				row.ProjectionTone = ui.ToneWarn
			}
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

func quotaProjectionNote(used int, limSec, resetSec int64) string {
	if used <= 0 || limSec <= 0 || resetSec <= 0 || limSec <= resetSec {
		return ""
	}
	projected := ui.ProjectUsage(used, limSec, resetSec)
	if projected <= used {
		return ""
	}
	eta := ui.ProjectETA(used, limSec, resetSec)
	if eta > 0 {
		return fmt.Sprintf("~%d%% at reset; 100%% in %s", projected, ui.DurationShort(eta))
	}
	return fmt.Sprintf("~%d%% at reset", projected)
}

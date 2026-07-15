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

	// Resource checks distinguish a proven unchanged resource from a skipped
	// or failed best-effort sync. Updated is only rendered on a checked,
	// successful resource.
	SkillsSync ResourceSync
	ConfigSync ResourceSync
	AuthSynced bool
	LaunchArgs []string // upstream args for per-invocation model/profile truth
	// StatusOnly suppresses resource-sync markers because `cdx status` probes
	// /auth only and must not present unprobed skills/config as healthy.
	StatusOnly bool
	// Sessions carries the historical API `sessions` block. Its fleet values
	// are recent-host / managed-sync activity, not proven engine launches.
	// Nil hides the block; LocalNow is computed wrapper-side.
	Sessions *SessionCounts
}

// ResourceSync is the per-run outcome for one boot-screen resource marker.
// Err is advisory: resource sync remains best-effort and never blocks launch.
type ResourceSync struct {
	Checked bool
	Updated bool
	Err     error
}

// SessionCounts is the historical internal name for the activity block.
// LocalNow comes from the host process table; the compatible server fields
// represent recent hosts and managed sync attempts, not proven launches.
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
	var launchLane string
	var apiCalls int64
	var dots []ui.HealthDot
	var quotaRows []ui.QuotaRow
	var warnText, blockText string
	var forecastTone ui.Tone
	result := "Ready — all systems operational."
	if in.StatusOnly {
		result = "API and auth checks passed."
	}
	resultTone := ui.ToneOK

	if auth != nil {
		if auth.Host != nil {
			insecure = !auth.Host.Secure
			browserOS = auth.Host.BrowserOSMCPEnabled
			laneStr = auth.Host.LanePreference
			if codex.LaneModel(laneStr) != "" {
				launchLane = strings.ToLower(strings.TrimSpace(laneStr))
			}
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
		if auth.ChatGPT != nil {
			laneStr = effectiveQuotaLane(auth)
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
		forecastTone = activeQuotaProjectionTone(quotaRows, effectiveQuotaLane(auth))
		if warnText == "" {
			switch forecastTone {
			case ui.ToneFail:
				warnText = fmt.Sprintf("%s lane quota forecast crosses the configured limit before reset", effectiveQuotaLane(auth))
			case ui.ToneWarn:
				warnText = fmt.Sprintf("%s lane quota forecast approaches the configured limit before reset", effectiveQuotaLane(auth))
			}
		}
	} else {
		// No auth response — degrade.
		dots = []ui.HealthDot{
			{Name: "api", Tone: ui.ToneFail},
			{Name: "auth", Tone: ui.ToneFail},
		}
		result = "API unreachable; run `cdx doctor`."
		resultTone = ui.ToneFail
	}
	if strings.TrimSpace(model) == "" || strings.TrimSpace(effort) == "" {
		localModel, localEffort := localCodexPreferences()
		if strings.TrimSpace(model) == "" {
			model = localModel
		}
		if strings.TrimSpace(effort) == "" {
			effort = localEffort
		}
	}
	if selection := codex.ModelContext(in.LaunchArgs, launchLane); selection != "" {
		model = selection
	}
	if selection := codex.EffortContext(in.LaunchArgs, launchLane); selection != "" {
		effort = selection
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
	} else if forecastTone == ui.ToneFail && resultTone == ui.ToneOK {
		result = "Quota forecast crosses the configured limit before reset."
		resultTone = ui.ToneWarn
	} else if forecastTone == ui.ToneWarn && resultTone == ui.ToneOK {
		result = "Quota forecast approaches the configured limit before reset."
		resultTone = ui.ToneWarn
	} else if warnText != "" && resultTone == ui.ToneOK {
		result = quotaWarningResult(warnText)
		resultTone = ui.ToneWarn
	}
	if resourceSyncWarning(in) && resultTone == ui.ToneOK {
		result = "Attention — resource sync incomplete; launch continuing."
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

func quotaWarningResult(warning string) string {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(warning)), "chatgpt quota telemetry") {
		return "Quota telemetry needs attention."
	}
	return "Quota is approaching the configured limit."
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
		{Label: "local procs", Count: s.LocalNow},
		{Label: "hosts 30m", Count: s.FleetNow},
		{Label: "syncs UTC day", Count: s.Today},
		{Label: "syncs UTC month", Count: s.Month},
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

	dots := []ui.HealthDot{
		{Name: "api", Tone: apiTone},
		{Name: "auth", Tone: authTone, Updated: in.AuthSynced},
	}
	if !in.StatusOnly {
		dots = append(dots,
			ui.HealthDot{Name: "skills", Tone: resourceTone(in.SkillsSync), Updated: resourceUpdated(in.SkillsSync)},
			ui.HealthDot{Name: "config", Tone: resourceTone(in.ConfigSync), Updated: resourceUpdated(in.ConfigSync)},
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
			// Runner failure blocks new canonical stores, not retrieve/launch.
			// Show attention without falsely declaring this run blocked.
			rt = ui.ToneWarn
		default:
			rt = ui.ToneWarn
		}
		dots = append(dots, ui.HealthDot{Name: "runner", Tone: rt})
	}
	return dots
}

func resourceTone(state ResourceSync) ui.Tone {
	if state.Err != nil {
		return ui.ToneWarn
	}
	if !state.Checked {
		return ui.ToneDim
	}
	return ui.ToneOK
}

func resourceUpdated(state ResourceSync) bool {
	return state.Checked && state.Err == nil && state.Updated
}

func resourceSyncWarning(in Inputs) bool {
	return in.SkillsSync.Err != nil || in.ConfigSync.Err != nil
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
	telemetryWarning := quotaTelemetryWarning(q, time.Now())
	activeLane := effectiveQuotaLane(auth)
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
	addRow := func(fallbackLabel string, used *int, lim, resetAfter *int64, lane string) {
		if used == nil {
			return
		}
		label := quotaWindowLabel(fallbackLabel, lim, lane)
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
		if telemetryWarning == "" {
			row.Projection = quotaProjectionNote(*used, limSec, resetSec)
		}
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

		// Inactive-lane saturation is useful context, not a launch gate for the
		// lane this host will actually use.
		if telemetryWarning != "" || lane != activeLane {
			return
		}
		if *used >= limitPct && blockText == "" {
			blockText = fmt.Sprintf("%s quota reached (%d%% used%s)", strings.TrimSpace(label), *used, quotaResetDetail(row.ResetAfter))
		} else if *used >= warnAt && warnText == "" {
			warnText = fmt.Sprintf("%s quota high (%d%% used%s)", strings.TrimSpace(label), *used, quotaResetDetail(row.ResetAfter))
		}
	}

	addRow("5h", q.PrimaryUsed, q.PrimaryLimitSec, q.PrimaryResetAfter, "normal")
	addRow("weekly", q.SecondaryUsed, q.SecondaryLimitSec, q.SecondaryResetAfter, "normal")
	addRow("5h", q.SparkPrimaryUsed, q.SparkPrimaryLimitSec, q.SparkPrimaryResetAfter, "spark")
	addRow("weekly", q.SparkSecondaryUsed, q.SparkSecondaryLimitSec, q.SparkSecondaryResetAfter, "spark")

	// Stale, malformed, or unavailable quota telemetry remains useful as
	// last-known context, but it must never warn/block from percentage,
	// provider-gate, or burn-rate projections as if it were current.
	if telemetryWarning != "" {
		return rows, telemetryWarning, ""
	}
	if blockText == "" && (providerQuotaBlocked(q, activeLane) || quotaStatusBlocked(q.Status)) {
		blockText = fmt.Sprintf("%s lane quota reached (provider reported limit)", activeLane)
	}
	return rows, warnText, blockText
}

func quotaStatusBlocked(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "limit_reached", "rate_limited":
		return true
	default:
		return false
	}
}

func effectiveQuotaLane(auth *orchestrator.AuthRetrieveResponse) string {
	preference := ""
	reported := ""
	if auth != nil && auth.Host != nil {
		preference = auth.Host.LanePreference
	}
	if auth != nil && auth.ChatGPT != nil {
		reported = auth.ChatGPT.ActiveLane
	}
	return codex.EffectiveLane(preference, reported)
}

func providerQuotaBlocked(q *orchestrator.ChatGPTQuota, lane string) bool {
	if q == nil {
		return false
	}
	if lane == "spark" {
		return boolTrue(q.SparkRateLimitReached) || boolFalse(q.SparkRateAllowed)
	}
	return boolTrue(q.RateLimitReached) || boolFalse(q.RateAllowed)
}

func boolTrue(value *bool) bool  { return value != nil && *value }
func boolFalse(value *bool) bool { return value != nil && !*value }

func activeQuotaProjectionTone(rows []ui.QuotaRow, activeLane string) ui.Tone {
	tone := ui.Tone("")
	for _, row := range rows {
		if row.Lane != activeLane {
			continue
		}
		switch row.ProjectionTone {
		case ui.ToneFail:
			return ui.ToneFail
		case ui.ToneWarn:
			tone = ui.ToneWarn
		}
	}
	return tone
}

func quotaWindowLabel(fallback string, limitSeconds *int64, lane string) string {
	label := strings.TrimSpace(fallback)
	if limitSeconds != nil && *limitSeconds > 0 {
		seconds := *limitSeconds
		switch {
		case seconds == int64(7*24*time.Hour/time.Second):
			label = "weekly"
		case seconds%int64(24*time.Hour/time.Second) == 0:
			label = fmt.Sprintf("%dd", seconds/int64(24*time.Hour/time.Second))
		case seconds%int64(time.Hour/time.Second) == 0:
			label = fmt.Sprintf("%dh", seconds/int64(time.Hour/time.Second))
		case seconds%int64(time.Minute/time.Second) == 0:
			label = fmt.Sprintf("%dm", seconds/int64(time.Minute/time.Second))
		default:
			label = ui.DurationShort(time.Duration(seconds) * time.Second)
		}
	}
	if lane == "spark" {
		if label == "weekly" {
			label = "week"
		}
		return "⚡ " + label
	}
	return label
}

func quotaResetDetail(resetAfter time.Duration) string {
	if resetAfter <= 0 {
		return "; reset unknown"
	}
	return "; resets in " + ui.DurationShort(resetAfter)
}

func quotaTelemetryWarning(q *orchestrator.ChatGPTQuota, now time.Time) string {
	if q == nil {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(q.Status)) {
	case "error", "unavailable":
		return "ChatGPT quota telemetry unavailable"
	}
	if strings.TrimSpace(q.FetchedAt) == "" {
		return ""
	}
	fetchedAt, err := time.Parse(time.RFC3339, q.FetchedAt)
	if err != nil {
		return "ChatGPT quota telemetry timestamp is invalid"
	}
	if now.Sub(fetchedAt) > 30*time.Minute {
		return "ChatGPT quota telemetry is stale"
	}
	return ""
}

func quotaProjectionNote(used int, limSec, resetSec int64) string {
	if used <= 0 || !ui.ProjectionReady(limSec, resetSec) {
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

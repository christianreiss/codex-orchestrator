// Package summary builds the ScreenInput for the clx boot/status screen.
package summary

import (
	"context"
	"fmt"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
)

type Inputs struct {
	Config         *config.Config
	WrapperVersion string
	Auth           *orchestrator.AuthRetrieveResponse
	AuthErr        error
	Concurrent     bool
	ConcurrentNote string // override text for the "concurrent" boot-screen row
	SkillsUpdated  bool
	AgentsUpdated  bool
	ConfigUpdated  bool
	AuthSynced     bool
	// StatusOnly suppresses resource-sync markers because `clx status` probes
	// /auth only and must not present unprobed skills/config as healthy.
	StatusOnly bool
	// BypassPermissions mirrors --dangerously-skip-permissions for this run;
	// lights the boot-screen warning badge only, never persisted.
	BypassPermissions bool
}

func Build(ctx context.Context, in Inputs) ui.ScreenInput {
	cfg := in.Config
	auth := in.Auth

	claudeVer := claude.Version(ctx)
	claudeTone := ui.ToneOK
	if unknownVersion(claudeVer) {
		claudeTone = ui.ToneWarn
	}
	claudeTarget := ""

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
	if cfg != nil {
		insecure = !cfg.Host.Secure
	}
	fqdn := ""
	model := ""
	effort := ""
	if cfg != nil {
		fqdn = cfg.Host.FQDN
		if cfg.EngineOptions.ClaudeModelOverride != nil {
			model = *cfg.EngineOptions.ClaudeModelOverride
		}
	}

	var apiCalls int64
	var dots []ui.HealthDot
	result := "Ready — all systems operational."
	resultTone := ui.ToneOK

	if auth != nil {
		if auth.Host != nil {
			insecure = !auth.Host.Secure
			apiCalls = auth.Host.APICalls
			if model == "" {
				model = auth.Host.ClaudeModelOverride
			}
			if strings.TrimSpace(auth.Host.ReasoningEffort) != "" {
				effort = strings.TrimSpace(auth.Host.ReasoningEffort)
			}
		}
		if auth.APICalls > 0 {
			apiCalls = auth.APICalls
		}
		if auth.Versions != nil {
			if target := clientTarget(auth.Versions); shouldShowClientTarget(claudeVer, target, auth.Versions.ClientVersionEnforceExact) {
				claudeTone = ui.ToneWarn
				claudeTarget = target
			}
			if auth.Versions.WrapperVersion != nil && wrapperVer != "" && wrapperVer != *auth.Versions.WrapperVersion {
				wrapperTone = ui.ToneWarn
				wrapperTarget = *auth.Versions.WrapperVersion
			}
		}
		dots = buildDots(auth, in)
	} else {
		dots = []ui.HealthDot{
			{Name: "api", Tone: ui.ToneFail},
			{Name: "auth", Tone: ui.ToneFail},
		}
		result = "API unreachable; run `clx doctor`."
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
	worst := worstTone(dots, claudeTone, wrapperTone)
	switch worst {
	case ui.ToneFail:
		if resultTone != ui.ToneFail {
			result = "Attention required; run `clx doctor`."
			resultTone = ui.ToneFail
		}
	case ui.ToneWarn:
		if resultTone == ui.ToneOK {
			result = "Ready with warnings; run `clx doctor` for details."
			resultTone = ui.ToneWarn
		}
	}
	if in.BypassPermissions && resultTone != ui.ToneFail {
		result = "Ready with permission prompts bypassed for this run."
		resultTone = ui.ToneWarn
	}

	theme := ""
	if cfg != nil && cfg.EngineOptions.AdminThemeHint != nil {
		theme = *cfg.EngineOptions.AdminThemeHint
	}

	return ui.ScreenInput{
		WrapperVersion:    wrapperVer,
		WrapperTone:       wrapperTone,
		WrapperTarget:     wrapperTarget,
		ClaudeVersion:     claudeVer,
		ClaudeTone:        claudeTone,
		ClaudeTarget:      claudeTarget,
		HostFQDN:          fqdn,
		Insecure:          insecure,
		Model:             model,
		Effort:            effort,
		APICalls:          apiCalls,
		Concurrent:        in.Concurrent,
		ConcurrentNote:    in.ConcurrentNote,
		Dots:              dots,
		ResultLabel:       result,
		ResultTone:        resultTone,
		Theme:             theme,
		BypassPermissions: in.BypassPermissions,
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
	return claude.SemverGT(target, current)
}

func unknownVersion(version string) bool {
	version = strings.TrimSpace(version)
	return version == "" || strings.EqualFold(version, "unknown")
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
			ui.HealthDot{Name: "skills", Tone: ui.ToneOK, Updated: in.SkillsUpdated},
			ui.HealthDot{Name: "config", Tone: ui.ToneOK, Updated: in.ConfigUpdated || in.AgentsUpdated},
		)
	}
	// Runner health dot: the server reports the credential-runner state for this
	// host (the background job that refreshes/verifies fleet credentials). Mirror
	// the cdx boot screen so operators get the same signal on Claude hosts.
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

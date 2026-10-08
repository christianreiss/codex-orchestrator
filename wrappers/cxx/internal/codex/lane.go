package codex

import (
	"os"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// applyLaneAndProfile injects the signed per-host model override when the user
// did not pass an explicit model/profile and lifecycle did not already inject
// the live lane preference.
//
// Mapping (mirroring the legacy bash wrapper):
//
//	normal → --model gpt-6-astra
//
// The `spark` lane is retired (gpt-5.3-codex-spark left the catalog in
// codex-cli 0.158.0); a stored `spark` preference maps to no model, so the fleet
// or per-host model applies.
//
// If the user already supplied --model or --profile we leave args alone.
func applyLaneAndProfile(cfg *config.Config, args []string) []string {
	if cfg == nil {
		return args
	}
	if hasModelOrProfile(args) {
		return args
	}
	model := ""
	if cfg.EngineOptions.ModelOverride != nil {
		model = strings.TrimSpace(*cfg.EngineOptions.ModelOverride)
	}
	if model == "" {
		return args
	}
	out := []string{"--model", model}
	if cfg.EngineOptions.ReasoningEffortOverride != nil &&
		strings.TrimSpace(*cfg.EngineOptions.ReasoningEffortOverride) != "" {
		out = append(out, "--config",
			"model_reasoning_effort="+*cfg.EngineOptions.ReasoningEffortOverride)
	}
	return append(out, args...)
}

// ApplyLanePreference makes the server-returned host lane effective for this
// launch. Explicit per-invocation model/profile flags always win.
func ApplyLanePreference(args []string, lane string) []string {
	if hasModelOrProfile(args) {
		return args
	}
	model := LaneModel(lane)
	if model == "" {
		return args
	}
	return append([]string{"--model", model}, args...)
}

// LaneModel is the fallback model for a persisted lane preference.
func LaneModel(lane string) string {
	switch strings.ToLower(strings.TrimSpace(lane)) {
	case "normal":
		return "gpt-6-astra"
	default:
		return ""
	}
}

// EffectiveLane resolves quota display/policy state: host preference first,
// then response telemetry, with normal as the fallback. Launch code separately
// requires a non-empty persisted preference so fleet/per-host model overrides
// remain effective when lane steering is cleared.
func EffectiveLane(preference, reported string) string {
	for _, candidate := range []string{preference, reported} {
		if strings.EqualFold(strings.TrimSpace(candidate), "normal") {
			return "normal"
		}
	}
	return "normal"
}

// ModelContext returns the launch selection suitable for the glanceable card.
// A profile is named explicitly because its model is resolved by Codex itself.
func ModelContext(args []string, lane string) string {
	for i, arg := range args {
		switch {
		case arg == "--model" || arg == "-m":
			if i+1 < len(args) {
				return strings.TrimSpace(args[i+1])
			}
		case strings.HasPrefix(arg, "--model="):
			return strings.TrimSpace(strings.TrimPrefix(arg, "--model="))
		case arg == "--profile" || arg == "-p":
			if i+1 < len(args) {
				return "profile:" + strings.TrimSpace(args[i+1])
			}
		case strings.HasPrefix(arg, "--profile="):
			return "profile:" + strings.TrimSpace(strings.TrimPrefix(arg, "--profile="))
		}
	}
	return LaneModel(lane)
}

// EffortContext mirrors the effective per-launch effort override. Explicit
// --config values win; otherwise the launch keeps its configured effort, so an
// empty result tells the summary to keep its existing fallback.
func EffortContext(args []string, lane string) string {
	for i, arg := range args {
		if arg != "--config" || i+1 >= len(args) {
			continue
		}
		const key = "model_reasoning_effort="
		if strings.HasPrefix(args[i+1], key) {
			return strings.TrimSpace(strings.TrimPrefix(args[i+1], key))
		}
	}
	return ""
}

func hasModelOrProfile(args []string) bool {
	return hasFlag(args, "--model") || hasFlag(args, "--profile") || hasFlag(args, "-m") || hasFlag(args, "-p")
}

// applyDangerousBypass prepends --dangerously-bypass-approvals-and-sandbox when
// the config's dangerously_bypass_approvals_and_sandbox key is set to true.
// The flag is only added when not already present in args.
func applyDangerousBypass(cfg *config.Config, args []string) []string {
	// Authenticated peer work retains existing authorization. A fleet-wide bypass chosen
	// for interactive work must never leak into the managed headless adapter.
	// Forging this marker can only remove privilege; it cannot add any.
	if strings.TrimSpace(os.Getenv("CXX_AGENT_MESSAGING_MESSAGE_ID")) != "" {
		return args
	}
	if cfg == nil || !cfg.EngineOptions.DangerouslyBypassApprovalsAndSandbox {
		return args
	}
	const flag = "--dangerously-bypass-approvals-and-sandbox"
	if hasFlag(args, flag) {
		return args
	}
	return append([]string{flag}, args...)
}

func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
		if strings.HasPrefix(a, flag+"=") {
			return true
		}
	}
	return false
}

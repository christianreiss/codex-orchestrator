package codex

import (
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
)

// applyLaneAndProfile injects --model / --profile flags when the user didn't
// pass them explicitly. The lane preference comes from config.engine_options
// (the orchestrator sets it via the host's lane preference). If no preference
// is set, args are unchanged.
//
// Mapping (mirroring the legacy bash wrapper):
//
//	spark  → --model gpt-5.3-codex-spark
//	normal → --model gpt-5.5
//
// If the user already supplied --model or --profile we leave args alone.
func applyLaneAndProfile(cfg *config.Config, args []string) []string {
	if cfg == nil {
		return args
	}
	if hasFlag(args, "--model") || hasFlag(args, "--profile") {
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

// applyDangerousBypass prepends --dangerously-bypass-approvals-and-sandbox when
// the config's dangerously_bypass_approvals_and_sandbox key is set to true.
// The flag is only added when not already present in args.
func applyDangerousBypass(cfg *config.Config, args []string) []string {
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

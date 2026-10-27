package agentportal

import (
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"strings"
)

// Pin the launch selection for recovery rather than reading a later fleet default.
func supervisorModel(cfg *config.Config, input StartInput) string {
	for i, arg := range input.NativeArgs {
		if (arg == "--model" || arg == "-m") && i+1 < len(input.NativeArgs) {
			return input.NativeArgs[i+1]
		}
		if strings.HasPrefix(arg, "--model=") {
			return strings.TrimPrefix(arg, "--model=")
		}
	}
	if cfg == nil {
		return ""
	}
	var override *string
	switch input.Engine {
	case "codex":
		override = cfg.EngineOptions.ModelOverride
	case "claude":
		override = cfg.EngineOptions.ClaudeModelOverride
	case "grok":
		override = cfg.EngineOptions.GrokModelOverride
	}
	if override != nil && strings.TrimSpace(*override) != "" {
		return strings.TrimSpace(*override)
	}
	if cfg.EngineOptions.ModelCatalog != nil {
		return cfg.EngineOptions.ModelCatalog.DefaultModel
	}
	return ""
}

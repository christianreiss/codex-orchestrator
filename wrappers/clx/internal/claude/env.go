// Package claude spawns the upstream `claude` CLI with the wrapper's env.
package claude

import (
	"fmt"
	"os"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
)

// BuildEnv returns the environment claude should see.
func BuildEnv(cfg *config.Config) []string {
	env := os.Environ()
	put := func(k, v string) { env = append(env, fmt.Sprintf("%s=%s", k, v)) }

	// The orchestrator exposes an Anthropic-compatible endpoint under /anthropic/v1.
	put("ANTHROPIC_BASE_URL", cfg.Orchestrator.BaseURL+"/anthropic")
	put("ANTHROPIC_API_KEY", cfg.Orchestrator.APIKey)

	if cfg.EngineOptions.ClaudeModelOverride != nil && *cfg.EngineOptions.ClaudeModelOverride != "" {
		put("CLX_MODEL", *cfg.EngineOptions.ClaudeModelOverride)
		put("ANTHROPIC_MODEL", *cfg.EngineOptions.ClaudeModelOverride)
	}
	put("CLX_HOST_FQDN", cfg.Host.FQDN)
	put("CLX_HOST_ID", fmt.Sprintf("%d", cfg.Host.ID))
	put("CLX_WRAPPER_VERSION", cfg.Wrapper.Version)
	return env
}

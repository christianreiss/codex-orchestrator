// Package codex spawns the upstream `codex` CLI with the prepared env + args.
// We don't reimplement Codex sandboxing — Seatbelt/namespace work stays in the
// upstream binary. The wrapper's job is config + transport.
package codex

import (
	"fmt"
	"os"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// BuildEnv returns the environment variables Codex should see, layered on top
// of the parent env. Returns a slice in KEY=value form, ready for os/exec.
func BuildEnv(cfg *config.Config) []string {
	env := os.Environ()

	put := func(k, v string) {
		env = append(env, fmt.Sprintf("%s=%s", k, v))
	}

	// API endpoint the upstream codex CLI talks to (the orchestrator proxies).
	put("OPENAI_BASE_URL", cfg.Orchestrator.BaseURL+"/v1")
	put("OPENAI_API_KEY", cfg.Orchestrator.APIKey)

	if cfg.EngineOptions.ModelOverride != nil && *cfg.EngineOptions.ModelOverride != "" {
		put("CDX_MODEL", *cfg.EngineOptions.ModelOverride)
	}
	if cfg.EngineOptions.ReasoningEffortOverride != nil && *cfg.EngineOptions.ReasoningEffortOverride != "" {
		put("CDX_REASONING_EFFORT", *cfg.EngineOptions.ReasoningEffortOverride)
	}
	put("CDX_HOST_FQDN", cfg.Host.FQDN)
	put("CDX_HOST_ID", fmt.Sprintf("%d", cfg.Host.ID))
	put("CDX_WRAPPER_VERSION", cfg.Wrapper.Version)

	return env
}

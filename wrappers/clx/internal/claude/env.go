// Package claude spawns the upstream `claude` CLI with the wrapper's env.
package claude

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
)

// BuildEnv returns the environment claude should see.
func BuildEnv(cfg *config.Config) []string {
	env := os.Environ()
	put := func(k, v string) { env = append(env, fmt.Sprintf("%s=%s", k, v)) }

	// NOTE: We deliberately do NOT inject ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL.
	// clx's job mirrors cdx 1:1 — keep the account-login file current and let the
	// upstream CLI use it natively. Claude Code reads ~/.claude/.credentials.json
	// (the `claudeAiOauth` account login the fleet distributes) on its own. Unlike
	// codex (which ignores OPENAI_API_KEY in account mode), Claude Code *consumes*
	// ANTHROPIC_API_KEY — injecting it pops the "detected custom API key" prompt
	// and overrides the OAuth login with a key that doesn't authenticate. The
	// orchestrator's /anthropic proxy is a separate gateway for issued
	// `sk-claude-*` keys; host orchestrator keys are not valid there.

	if cfg.EngineOptions.ClaudeModelOverride != nil && *cfg.EngineOptions.ClaudeModelOverride != "" {
		put("CLX_MODEL", *cfg.EngineOptions.ClaudeModelOverride)
		put("ANTHROPIC_MODEL", *cfg.EngineOptions.ClaudeModelOverride)
	}
	put("CLX_HOST_FQDN", cfg.Host.FQDN)
	put("CLX_HOST_ID", fmt.Sprintf("%d", cfg.Host.ID))
	put("CLX_WRAPPER_VERSION", cfg.Wrapper.Version)

	// Legacy clx parity: surface the synced CLAUDE.md path so Claude's prompt
	// scaffolding can pick it up without re-discovering home itself.
	if home, err := os.UserHomeDir(); err == nil {
		put("CLAUDE_MD", filepath.Join(home, ".claude", "CLAUDE.md"))
	}
	return env
}

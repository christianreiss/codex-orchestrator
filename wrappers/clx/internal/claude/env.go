// Package claude spawns the upstream `claude` CLI with the wrapper's env.
package claude

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
)

// runtimeAuthOverrideEnv are credential, provider, and endpoint selectors that
// can make Claude Code execute a different credential from the runner-verified
// ~/.claude/.credentials.json. BuildEnv removes every inherited copy. The
// per-run command-line settings overlay in exec.go also neutralizes copies from
// user/project settings, which Claude applies after process startup.
var runtimeAuthOverrideEnv = []string{
	"CCR_OAUTH_TOKEN_FILE",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_AWS_API_KEY",
	"ANTHROPIC_AWS_BASE_URL",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_BEDROCK_BASE_URL",
	"ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"ANTHROPIC_FOUNDRY_AUTH_TOKEN",
	"ANTHROPIC_FOUNDRY_BASE_URL",
	"ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
	"ANTHROPIC_IDENTITY_TOKEN",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_VERTEX_BASE_URL",
	"CLAUDE_API_KEY",
	"CLAUDE_BRIDGE_OAUTH_TOKEN",
	"CLAUDE_CONFIG_DIR",
	"CLAUDE_SESSION_INGRESS_TOKEN_FILE",
	"CLAUDE_TRUSTED_DEVICE_TOKEN",
	"CLAUDE_CODE_API_BASE_URL",
	"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
	"CLAUDE_CODE_CUSTOM_OAUTH_URL",
	"CLAUDE_CODE_HFI_BEARER_TOKEN",
	"CLAUDE_CODE_HOST_AUTH_ENV_VAR",
	"CLAUDE_CODE_OAUTH_CLIENT_ID",
	"CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
	"CLAUDE_CODE_OAUTH_SCOPES",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
	"CLAUDE_CODE_SESSION_ACCESS_TOKEN",
	"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_GATEWAY",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
}

var runtimeProviderSelectors = map[string]struct{}{
	"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST":   {},
	"CLAUDE_CODE_USE_ANTHROPIC_AWS":          {},
	"CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD": {},
	"CLAUDE_CODE_USE_BEDROCK":                {},
	"CLAUDE_CODE_USE_FOUNDRY":                {},
	"CLAUDE_CODE_USE_GATEWAY":                {},
	"CLAUDE_CODE_USE_MANTLE":                 {},
	"CLAUDE_CODE_USE_VERTEX":                 {},
}

// BuildEnv returns the environment claude should see.
func BuildEnv(cfg *config.Config) []string {
	return buildEnv(cfg, nil)
}

func buildEnv(cfg *config.Config, args []string) []string {
	env := filterEnv(os.Environ(), runtimeAuthOverrideEnv)
	put := func(k, v string) { env = append(env, fmt.Sprintf("%s=%s", k, v)) }

	// The selected verified on-disk credential is authoritative. Native OAuth
	// needs no environment credential. Native API-key mode receives only the
	// selected genuine Anthropic key; a stale ambient key must never win.
	if mode, key := managedRuntimeAuth(); mode == "api_key" && !isInteractiveAuthLogin(args) {
		put("ANTHROPIC_API_KEY", key)
	}
	if authDir, err := managedClaudeConfigDir(); err == nil {
		put("CLAUDE_CONFIG_DIR", authDir)
	}

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

func managedRuntimeAuth() (mode, key string) {
	raw, err := ReadAuth()
	if err != nil || len(raw) == 0 {
		return "", ""
	}
	if hasNativeClaudeOAuth(raw) {
		return "oauth", ""
	}
	key = strings.TrimSpace(extractAnthropicKey(raw))
	if isRunnableAnthropicAPIKey(key) {
		return "api_key", key
	}
	return "", ""
}

func managedClaudeConfigDir() (string, error) {
	path, err := AuthPath()
	if err != nil {
		return "", err
	}
	return filepath.Dir(path), nil
}

func filterEnv(env, names []string) []string {
	blocked := make(map[string]struct{}, len(names))
	for _, name := range names {
		blocked[name] = struct{}{}
	}
	out := make([]string, 0, len(env))
	for _, item := range env {
		name := item
		if idx := strings.IndexByte(item, '='); idx >= 0 {
			name = item[:idx]
		}
		if _, drop := blocked[name]; !drop {
			out = append(out, item)
		}
	}
	return out
}

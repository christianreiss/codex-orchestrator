package claude

import (
	"context"
	"fmt"
	"os"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ipv4"
)

// PreExec performs side-effect setup before Claude Code is spawned. Currently:
//
//  1. Exports ANTHROPIC_API_KEY from credentials.json if present.
//  2. Starts an IPv4-forcing local proxy when CLAUDE_FORCE_IPV4=1.
//
// Returns a teardown function the caller must defer.
func PreExec(ctx context.Context, cfg *config.Config) (func(), error) {
	teardown := func() {}

	if err := exportAnthropicAPIKey(); err != nil {
		fmt.Fprintln(os.Stderr, "clx: ANTHROPIC_API_KEY export failed:", err)
	}

	if os.Getenv("CLAUDE_FORCE_IPV4") == "1" || os.Getenv("CODEX_FORCE_IPV4") == "1" {
		p, err := ipv4.Start(ctx)
		if err != nil {
			fmt.Fprintln(os.Stderr, "clx: IPv4 proxy failed to start:", err)
		} else {
			_ = os.Setenv("HTTP_PROXY", p.URL)
			_ = os.Setenv("HTTPS_PROXY", p.URL)
			_ = os.Setenv("ALL_PROXY", p.URL)
			teardown = p.Stop
		}
	}
	_ = cfg
	return teardown, nil
}

// exportAnthropicAPIKey reads ~/.claude/.credentials.json and pulls the first
// usable API key into ANTHROPIC_API_KEY (matching the legacy wrapper).
func exportAnthropicAPIKey() error {
	if os.Getenv("ANTHROPIC_API_KEY") != "" {
		return nil
	}
	raw, err := ReadAuth()
	if err != nil || len(raw) == 0 {
		return nil
	}
	if key := extractAnthropicKey(raw); key != "" {
		_ = os.Setenv("ANTHROPIC_API_KEY", key)
	}
	return nil
}

// extractAnthropicKey accepts the four credential shapes the legacy wrapper
// supports and returns the first usable key.
func extractAnthropicKey(raw []byte) string {
	type oauth struct {
		AccessToken string `json:"accessToken"`
	}
	type creds struct {
		APIKey          string `json:"api_key,omitempty"`
		AnthropicAPIKey string `json:"anthropic_api_key,omitempty"`
		Auths           map[string]struct {
			Token string `json:"token"`
		} `json:"auths,omitempty"`
		ClaudeAIOauth oauth `json:"claudeAiOauth,omitempty"`
	}
	var c creds
	if err := unmarshalLoose(raw, &c); err != nil {
		return ""
	}
	if c.APIKey != "" {
		return c.APIKey
	}
	if c.AnthropicAPIKey != "" {
		return c.AnthropicAPIKey
	}
	if c.ClaudeAIOauth.AccessToken != "" {
		return c.ClaudeAIOauth.AccessToken
	}
	if a, ok := c.Auths["api.anthropic.com"]; ok && a.Token != "" {
		return a.Token
	}
	return ""
}

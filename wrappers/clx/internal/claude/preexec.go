package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ipv4"
)

// PreExec performs side-effect setup before Claude Code is spawned. Currently:
//
//  0. Refuses launch if the runtime hostname does not match the FQDN baked
//     into config (override with CLAUDE_ALLOW_FQDN_MISMATCH=1).
//  1. Starts an IPv4-forcing local proxy when CLAUDE_FORCE_IPV4=1.
//
// Returns a teardown function the caller must defer.
func PreExec(ctx context.Context, cfg *config.Config) (func(), error) {
	teardown := func() {}

	if err := GuardFQDN(cfg); err != nil {
		return teardown, err
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

// GuardFQDN refuses to proceed when the baked cfg.Host.FQDN doesn't match
// the runtime hostname. Suffix match counts (a baked "alpha.example.com"
// matches the short hostname "alpha"). Override with CLAUDE_ALLOW_FQDN_MISMATCH=1.
func GuardFQDN(cfg *config.Config) error {
	if cfg == nil || strings.TrimSpace(cfg.Host.FQDN) == "" {
		return nil
	}
	if os.Getenv("CLAUDE_ALLOW_FQDN_MISMATCH") == "1" {
		return nil
	}
	real, err := os.Hostname()
	if err != nil || strings.TrimSpace(real) == "" {
		return nil
	}
	baked := strings.ToLower(strings.TrimSpace(cfg.Host.FQDN))
	got := strings.ToLower(strings.TrimSpace(real))
	if baked == got {
		return nil
	}
	if strings.HasSuffix(got, "."+baked) || strings.HasSuffix(baked, "."+got) {
		return nil
	}
	if strings.HasPrefix(baked, got+".") || strings.HasPrefix(got, baked+".") {
		return nil
	}
	return fmt.Errorf("clx: hostname %q does not match baked FQDN %q (set CLAUDE_ALLOW_FQDN_MISMATCH=1 to override)", real, cfg.Host.FQDN)
}

// extractAnthropicKey accepts the four credential shapes the legacy wrapper
// supports and returns the first usable key.
func extractAnthropicKey(raw []byte) string {
	type oauth struct {
		AccessToken string `json:"accessToken"`
	}
	type creds struct {
		APIKey             string `json:"api_key,omitempty"`
		AnthropicAPIKey    string `json:"anthropic_api_key,omitempty"`
		AnthropicAPIKeyEnv string `json:"ANTHROPIC_API_KEY,omitempty"`
		Tokens             struct {
			AnthropicAPIKey    string `json:"anthropic_api_key,omitempty"`
			AnthropicAPIKeyEnv string `json:"ANTHROPIC_API_KEY,omitempty"`
		} `json:"tokens,omitempty"`
		Auths map[string]struct {
			Token string `json:"token"`
		} `json:"auths,omitempty"`
		ClaudeAIOauth oauth `json:"claudeAiOauth,omitempty"`
	}
	var c creds
	if err := unmarshalLoose(raw, &c); err != nil {
		return ""
	}
	if strings.TrimSpace(c.ClaudeAIOauth.AccessToken) != "" {
		return c.ClaudeAIOauth.AccessToken
	}
	if strings.TrimSpace(c.APIKey) != "" {
		return c.APIKey
	}
	if strings.TrimSpace(c.AnthropicAPIKey) != "" {
		return c.AnthropicAPIKey
	}
	if strings.TrimSpace(c.AnthropicAPIKeyEnv) != "" {
		return c.AnthropicAPIKeyEnv
	}
	if strings.TrimSpace(c.Tokens.AnthropicAPIKey) != "" {
		return c.Tokens.AnthropicAPIKey
	}
	if strings.TrimSpace(c.Tokens.AnthropicAPIKeyEnv) != "" {
		return c.Tokens.AnthropicAPIKeyEnv
	}
	if a, ok := c.Auths["api.anthropic.com"]; ok && strings.TrimSpace(a.Token) != "" {
		return a.Token
	}
	return ""
}

func hasNativeClaudeOAuth(raw []byte) bool {
	var doc struct {
		ClaudeAIOauth struct {
			AccessToken string `json:"accessToken"`
		} `json:"claudeAiOauth"`
	}
	return json.Unmarshal(raw, &doc) == nil && strings.TrimSpace(doc.ClaudeAIOauth.AccessToken) != ""
}

// Package config defines the typed per-host wrapper config baked by the
// orchestrator's api/src/services/wrapper-config.ts. The struct mirrors
// schemas/host-config-v1.json.
package config

import "strings"

const SchemaVersion = 1

const (
	EngineCodex  = "codex"
	EngineClaude = "claude"
)

type Config struct {
	SchemaVersion int           `json:"schema_version"`
	Engine        string        `json:"engine"`
	IssuedAt      string        `json:"issued_at"`
	ExpiresAt     *string       `json:"expires_at,omitempty"`
	Orchestrator  Orchestrator  `json:"orchestrator"`
	Host          Host          `json:"host"`
	EngineOptions EngineOptions `json:"engine_options"`
	Wrapper       Wrapper       `json:"wrapper"`
	ConfigVersion int64         `json:"config_version,omitempty"`
}

type Orchestrator struct {
	BaseURL        string  `json:"base_url"`
	APIKey         string  `json:"api_key"`
	CABundlePath   *string `json:"ca_bundle_path,omitempty"`
	AllowInsecure  bool    `json:"allow_insecure"`
	InstallationID string  `json:"installation_id"`
}

type Host struct {
	ID                  int64    `json:"id"`
	FQDN                string   `json:"fqdn"`
	Secure              bool     `json:"secure"`
	BrowserOSMCPEnabled bool     `json:"browseros_mcp_enabled,omitempty"`
	Engines             string   `json:"engines,omitempty"`
	EnginesList         []string `json:"engines_list,omitempty"`
}

type EngineOptions struct {
	Silent                               bool    `json:"silent"`
	ModelOverride                        *string `json:"model_override,omitempty"`
	ReasoningEffortOverride              *string `json:"reasoning_effort_override,omitempty"`
	AdminThemeHint                       *string `json:"admin_theme_hint,omitempty"`
	ClaudeModelOverride                  *string `json:"claude_model_override,omitempty"`
	DangerouslyBypassApprovalsAndSandbox bool    `json:"dangerously_bypass_approvals_and_sandbox,omitempty"`
}

type Wrapper struct {
	Version      string `json:"version"`
	Track        string `json:"track"`
	AutoUpdate   bool   `json:"auto_update"`
	BinaryURL    string `json:"binary_url"`
	BinarySHA256 string `json:"binary_sha256"`
}

// EnabledEngines returns the signed host engine set with the selected persona
// included as a fail-safe. It accepts both modern engines_list and the legacy
// comma-separated engines field.
func EnabledEngines(host Host, selected string) []string {
	raw := append([]string(nil), host.EnginesList...)
	if len(raw) == 0 {
		raw = strings.Split(host.Engines, ",")
	}
	raw = append(raw, selected)
	seen := map[string]bool{}
	out := make([]string, 0, 2)
	for _, engine := range raw {
		engine = strings.ToLower(strings.TrimSpace(engine))
		if (engine == EngineCodex || engine == EngineClaude) && !seen[engine] {
			seen[engine] = true
			out = append(out, engine)
		}
	}
	return out
}

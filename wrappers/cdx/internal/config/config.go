// Package config defines the typed per-host wrapper config produced by the
// orchestrator's PHP ConfigBaker. The struct mirrors schemas/host-config-v1.json.
package config

const SchemaVersion = 1

const EngineCodex = "codex"

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

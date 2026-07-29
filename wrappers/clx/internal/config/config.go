// Package config defines the typed per-host wrapper config for clx (Claude
// engine), baked by the orchestrator's api/src/services/wrapper-config.ts. The
// struct mirrors schemas/host-config-v1.json.
package config

const SchemaVersion = 1
const EngineClaude = "claude"

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
	ID          int64    `json:"id"`
	FQDN        string   `json:"fqdn"`
	Secure      bool     `json:"secure"`
	Engines     string   `json:"engines,omitempty"`
	EnginesList []string `json:"engines_list,omitempty"`
}

type EngineOptions struct {
	Silent              bool    `json:"silent"`
	ClaudeModelOverride *string `json:"claude_model_override,omitempty"`
	AdminThemeHint      *string `json:"admin_theme_hint,omitempty"`
}

type Wrapper struct {
	Version      string `json:"version"`
	Track        string `json:"track"`
	AutoUpdate   bool   `json:"auto_update"`
	BinaryURL    string `json:"binary_url"`
	BinarySHA256 string `json:"binary_sha256"`
}

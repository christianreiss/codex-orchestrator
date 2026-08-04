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
	SchemaVersion  int            `json:"schema_version"`
	Engine         string         `json:"engine"`
	IssuedAt       string         `json:"issued_at"`
	ExpiresAt      *string        `json:"expires_at,omitempty"`
	Orchestrator   Orchestrator   `json:"orchestrator"`
	Host           Host           `json:"host"`
	EngineOptions  EngineOptions  `json:"engine_options"`
	AgentMessaging AgentMessaging `json:"agent_messaging,omitempty"`
	Wrapper        Wrapper        `json:"wrapper"`
	ConfigVersion  int64          `json:"config_version,omitempty"`

	// sourcePath is local loader metadata, never part of the signed JSON. It lets
	// long-running wrapper capabilities re-check the same signed policy file
	// after an administrator changes fleet state.
	sourcePath string
}

// SourcePath returns the signed config file used to load c. The value is
// process-local metadata and is never marshalled into the host config.
func (c *Config) SourcePath() string {
	if c == nil {
		return ""
	}
	return c.sourcePath
}

type Orchestrator struct {
	BaseURL        string  `json:"base_url"`
	APIKey         string  `json:"api_key"`
	CABundlePath   *string `json:"ca_bundle_path,omitempty"`
	AllowInsecure  bool    `json:"allow_insecure"`
	InstallationID string  `json:"installation_id"`
}

type Host struct {
	ID                    int64    `json:"id"`
	FQDN                  string   `json:"fqdn"`
	Secure                bool     `json:"secure"`
	BrowserOSMCPEnabled   bool     `json:"browseros_mcp_enabled,omitempty"`
	// AgentMessagingEnabled is the retired per-host Agent Messaging switch. It
	// is still decoded so configs signed before the fleet switch became the
	// only switch keep loading, but nothing reads it.
	AgentMessagingEnabled bool     `json:"agent_messaging_enabled,omitempty"`
	Engines               string   `json:"engines,omitempty"`
	EnginesList           []string `json:"engines_list,omitempty"`
}

type EngineOptions struct {
	Silent                               bool    `json:"silent"`
	ModelOverride                        *string `json:"model_override,omitempty"`
	ReasoningEffortOverride              *string `json:"reasoning_effort_override,omitempty"`
	AdminThemeHint                       *string `json:"admin_theme_hint,omitempty"`
	ClaudeModelOverride                  *string `json:"claude_model_override,omitempty"`
	DangerouslyBypassApprovalsAndSandbox bool    `json:"dangerously_bypass_approvals_and_sandbox,omitempty"`
}

// AgentMessaging is optional for backward compatibility. A missing block
// decodes to Enabled=false, keeping old signed configs dormant.
type AgentMessaging struct {
	Enabled               bool `json:"enabled"`
	RelayPollSeconds      int  `json:"relay_poll_seconds,omitempty"`
	QueuedTTLSeconds      int  `json:"queued_ttl_seconds,omitempty"`
	ChannelPreviewEnabled bool `json:"channel_preview_enabled,omitempty"`
	// ListenEnabled gates the model-initiated receive plane: `agent_listen` and
	// the receive-capable bind it needs. Engine-neutral on purpose, unlike
	// ChannelPreviewEnabled, which stays Claude-only because it governs
	// unsolicited push into a transcript rather than a tool call the model made.
	ListenEnabled bool `json:"listen_enabled,omitempty"`
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

package codex

import (
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
)

func TestBuildEnvIncludesOverrides(t *testing.T) {
	model := "gpt-5.4"
	effort := "high"
	cfg := &config.Config{
		Orchestrator: config.Orchestrator{
			BaseURL: "https://orch.example.com",
			APIKey:  "sk-codex-abc",
		},
		Host:    config.Host{ID: 1, FQDN: "h.example.com"},
		Wrapper: config.Wrapper{Version: "0.6.0"},
		EngineOptions: config.EngineOptions{
			ModelOverride:           &model,
			ReasoningEffortOverride: &effort,
		},
	}
	env := BuildEnv(cfg)
	have := map[string]bool{}
	for _, kv := range env {
		have[kv] = true
	}
	for _, want := range []string{
		"OPENAI_BASE_URL=https://orch.example.com/v1",
		"OPENAI_API_KEY=sk-codex-abc",
		"CDX_MODEL=gpt-5.4",
		"CDX_REASONING_EFFORT=high",
		"CDX_HOST_FQDN=h.example.com",
		"CDX_HOST_ID=1",
		"CDX_WRAPPER_VERSION=0.6.0",
	} {
		if !have[want] {
			t.Errorf("missing %q", want)
		}
	}
}

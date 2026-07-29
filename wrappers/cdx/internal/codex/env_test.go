package codex

import (
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
)

// lastEnvValue mirrors how os/exec resolves duplicate keys in cmd.Env: the last
// occurrence wins, so that is the value the child codex process actually sees.
func lastEnvValue(env []string, name string) (string, bool) {
	prefix := name + "="
	value := ""
	found := false
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			value = strings.TrimPrefix(item, prefix)
			found = true
		}
	}
	return value, found
}

// BuildEnv layers onto os.Environ() rather than stripping inherited copies, so
// a developer's exported OPENAI_* must still lose to the orchestrator proxy.
func TestBuildEnvOrchestratorValuesOutrankAmbientCopies(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "sk-developer-ambient")
	t.Setenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
	t.Setenv("CDX_MODEL", "gpt-ambient")
	t.Setenv("CDX_HOST_FQDN", "ambient.example.com")

	model := "gpt-5.4"
	cfg := &config.Config{
		Orchestrator: config.Orchestrator{
			BaseURL: "https://orch.example.com",
			APIKey:  "sk-codex-abc",
		},
		Host:          config.Host{ID: 1, FQDN: "h.example.com"},
		Wrapper:       config.Wrapper{Version: "0.6.0"},
		EngineOptions: config.EngineOptions{ModelOverride: &model},
	}

	env := BuildEnv(cfg)
	for _, tc := range []struct{ name, want string }{
		{"OPENAI_BASE_URL", "https://orch.example.com/v1"},
		{"OPENAI_API_KEY", "sk-codex-abc"},
		{"CDX_MODEL", "gpt-5.4"},
		{"CDX_HOST_FQDN", "h.example.com"},
	} {
		got, ok := lastEnvValue(env, tc.name)
		if !ok {
			t.Errorf("%s missing from child environment", tc.name)
			continue
		}
		if got != tc.want {
			t.Errorf("%s=%q, want orchestrator value %q", tc.name, got, tc.want)
		}
	}
}

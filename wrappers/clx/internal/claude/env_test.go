package claude

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
)

// BuildEnv must NOT inject ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL: clx mirrors
// cdx 1:1 — the upstream CLI uses the distributed account-login file natively.
// Injecting the orchestrator key as ANTHROPIC_API_KEY popped Claude Code's
// "detected custom API key" prompt and pointed it at a proxy that rejects host
// keys.
func TestBuildEnv_DoesNotInjectAnthropicAuth(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("ANTHROPIC_BASE_URL", "")
	cfg := &config.Config{
		Orchestrator: config.Orchestrator{BaseURL: "https://orch.example", APIKey: "4f69fe-host-key"},
		Host:         config.Host{ID: 7, FQDN: "host.example"},
		Wrapper:      config.Wrapper{Version: "0.6.19"},
	}
	for _, kv := range BuildEnv(cfg) {
		if strings.HasPrefix(kv, "ANTHROPIC_API_KEY=") && kv != "ANTHROPIC_API_KEY=" {
			t.Errorf("BuildEnv must not set ANTHROPIC_API_KEY, got %q", kv)
		}
		if strings.HasPrefix(kv, "ANTHROPIC_BASE_URL=") && kv != "ANTHROPIC_BASE_URL=" {
			t.Errorf("BuildEnv must not set ANTHROPIC_BASE_URL, got %q", kv)
		}
	}
}

// exportAnthropicAPIKey must skip a Claude.ai OAuth token (sk-ant-oat…): Claude
// Code reads claudeAiOauth from ~/.claude/.credentials.json natively.
func TestExportAnthropicAPIKey_SkipsOAuthToken(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ANTHROPIC_API_KEY", "")
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"),
		[]byte(`{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := exportAnthropicAPIKey(); err != nil {
		t.Fatal(err)
	}
	if v := os.Getenv("ANTHROPIC_API_KEY"); v != "" {
		t.Errorf("OAuth token must NOT be bridged to ANTHROPIC_API_KEY, got %q", v)
	}
}

// A genuine Anthropic API key is still exported (api-key hosts keep working).
func TestExportAnthropicAPIKey_ExportsGenuineKey(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ANTHROPIC_API_KEY", "")
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"),
		[]byte(`{"api_key":"sk-ant-api03-real"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := exportAnthropicAPIKey(); err != nil {
		t.Fatal(err)
	}
	if v := os.Getenv("ANTHROPIC_API_KEY"); v != "sk-ant-api03-real" {
		t.Errorf("genuine API key should be exported, got %q", v)
	}
}

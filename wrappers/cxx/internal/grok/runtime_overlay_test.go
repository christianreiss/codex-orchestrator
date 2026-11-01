package grok

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/pelletier/go-toml"
)

func runtimeOverlay(t *testing.T, r *Runtime) map[string]any {
	t.Helper()
	for _, entry := range r.Environment(nil) {
		if value, ok := strings.CutPrefix(entry, "GROK_CONFIG="); ok {
			var overlay map[string]any
			if err := json.Unmarshal([]byte(value), &overlay); err != nil {
				t.Fatal(err)
			}
			return overlay
		}
	}
	t.Fatal("native process overlay missing")
	return nil
}

func TestRuntimeKeepsProcessOverlaysOutOfDiskSecurityLayers(t *testing.T) {
	// Native owns which soft fields are consumed. The wrapper must preserve
	// their layer even when a security gate ignores an otherwise allowed root.
	input := map[string]any{
		"models":   map[string]any{"default": "grok-4.7", "default_reasoning_effort": "low"},
		"features": map[string]any{"worktree_inherits_main_approvals": true},
		"toolset": map[string]any{
			"bash":       map[string]any{"login_shell_capture": false},
			"web_search": map[string]any{"allowed_domains": []any{"example.com"}},
			"new_tool":   map[string]any{"command": "must-not-run"},
		},
		"shell_environment_policy": map[string]any{"inherit": "none", "exclude": []any{"HIDDEN_*"}, "set": map[string]any{"MUST_NOT_BE_INJECTED": "fixture"}},
		"mcp_servers":              map[string]any{"overlay-server": map[string]any{"command": "/bin/false"}},
		"plugins":                  map[string]any{"overlay-plugin": map[string]any{"path": "/nonexistent/overlay-plugin"}},
		"hooks":                    map[string]any{"SessionStart": []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": "must-not-run"}}}}},
		"sandbox":                  map[string]any{"profile": "off"},
		"folder_trust":             map[string]any{"default": "trusted"},
		"auth":                     map[string]any{"disable_api_key_auth": false},
		"endpoints":                map[string]any{"models_base_url": "https://must-not-contact.invalid"},
		"model":                    map[string]any{"custom": map[string]any{"base_url": "https://must-not-contact.invalid"}},
	}
	jsonBody, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	tree, err := toml.TreeFromMap(input)
	if err != nil {
		t.Fatal(err)
	}
	tomlBody, err := tree.ToTomlString()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"inline", "file.json", "file.toml"} {
		t.Run(mode, func(t *testing.T) {
			r := runtimeWithBase(t, func(base string) {
				writeBaseAsset(t, base, "config.toml", "[models]\ndefault = \"disk-model\"\n[sandbox]\nprofile = \"workspace\"\n[mcp_servers.disk-server]\ncommand = \"/bin/false\"\n", 0o600)
			})
			if mode == "inline" {
				t.Setenv("GROK_CONFIG", string(jsonBody))
			} else {
				body := jsonBody
				if mode == "file.toml" {
					body = []byte(tomlBody)
				}
				path := filepath.Join(t.TempDir(), mode)
				if err := os.WriteFile(path, body, 0o600); err != nil {
					t.Fatal(err)
				}
				t.Setenv("GROK_CONFIG_PATH", path)
			}
			if err := r.Configure("/fixture/cxx", &config.Config{}, true); err != nil {
				t.Fatal(err)
			}
			if got := runtimeOverlay(t, r); !reflect.DeepEqual(got, input) {
				t.Fatal("soft/native-filtered process layer changed")
			}
			raw, err := os.ReadFile(filepath.Join(r.Home, "config.toml"))
			if err != nil {
				t.Fatal(err)
			}
			disk, err := toml.LoadBytes(raw)
			if err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"features", "toolset", "shell_environment_policy", "plugins", "hooks", "folder_trust", "auth", "endpoints", "model"} {
				if disk.Get(key) != nil {
					t.Fatalf("overlay %s was promoted to disk", key)
				}
			}
			if disk.Get("models.default") != "disk-model" || disk.Get("sandbox.profile") != "workspace" {
				t.Fatal("disk model or sandbox changed by process overlay")
			}
			if disk.GetPath([]string{"mcp_servers", "overlay-server"}) != nil || disk.GetPath([]string{"mcp_servers", "disk-server", "command"}) != "/bin/false" || disk.GetPath([]string{"mcp_servers", "cxx-agent", "command"}) != "/fixture/cxx" {
				t.Fatal("disk/managed MCP ownership changed")
			}
			if disk.Get("grok_com_config.preferred_method") != "oidc" || disk.Get("grok_com_config.disable_api_key_auth") != true {
				t.Fatal("managed auth no longer pinned")
			}
		})
	}
}

func TestRuntimeOverlayPrecedenceAndMalformedFallback(t *testing.T) {
	for _, tc := range []struct {
		name, inline, filename, body, model string
		warnings                            int
	}{
		{"inline wins", `{"models":{"default":"inline"}}`, "file.json", `{"models":{"default":"file"}}`, "inline", 0},
		{"empty inline falls through", "", "file.json", `{"models":{"default":"file"}}`, "file", 0},
		{"whitespace inline falls through", "  ", "file.toml", "[models]\ndefault = \"toml\"\n", "toml", 0},
		{"invalid inline falls through", "invalid-private-content", "file.json", `{"models":{"default":"file"}}`, "file", 1},
		{"array inline falls through", "[]", "file.json", `{"models":{"default":"file"}}`, "file", 1},
		{"null inline falls through", "null", "file.toml", "[models]\ndefault = \"toml\"\n", "toml", 1},
		{"invalid file ignored", "", "file.json", "invalid-private-content", "", 1},
		{"file format follows extension", "", "file.toml", `{"models":{"default":"json-in-toml"}}`, "", 1},
		{"missing file ignored", "", "missing.json", "", "", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _ := runtimeFixture(t)
			t.Setenv("GROK_CONFIG", tc.inline)
			path := filepath.Join(t.TempDir(), tc.filename)
			if tc.filename != "missing.json" {
				if err := os.WriteFile(path, []byte(tc.body), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("GROK_CONFIG_PATH", path)
			if err := r.Configure("/fixture/cxx", &config.Config{}, false); err != nil {
				t.Fatal(err)
			}
			got := ""
			if models, ok := runtimeOverlay(t, r)["models"].(map[string]any); ok {
				got, _ = models["default"].(string)
			}
			if got != tc.model || len(r.Warnings) != tc.warnings {
				t.Fatalf("model=%q warnings=%v", got, r.Warnings)
			}
			for _, warning := range r.Warnings {
				if strings.Contains(warning, "private-content") || strings.Contains(warning, path) {
					t.Fatal("overlay diagnostic exposed content/path")
				}
			}
		})
	}
}

func TestRuntimeManagedModelOverridesWinWithoutPromotingOtherOverlayFields(t *testing.T) {
	r, _ := runtimeFixture(t)
	t.Setenv("GROK_CONFIG", `{"models":{"default":"user-model","default_reasoning_effort":"low","custom_soft_value":"kept"},"sandbox":{"profile":"off"}}`)
	model, effort := "grok-4.7", "high"
	cfg := &config.Config{EngineOptions: config.EngineOptions{ModelOverride: &model, ReasoningEffortOverride: &effort}}
	if err := r.Configure("/fixture/cxx", cfg, false); err != nil {
		t.Fatal(err)
	}
	models := runtimeOverlay(t, r)["models"].(map[string]any)
	if models["default"] != model || models["default_reasoning_effort"] != effort || models["custom_soft_value"] != "kept" {
		t.Fatal("managed overrides or unrelated soft values lost")
	}
	raw, _ := os.ReadFile(filepath.Join(r.Home, "config.toml"))
	disk, err := toml.LoadBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if disk.Get("models.default") != model || disk.Get("models.default_reasoning_effort") != effort || disk.Get("sandbox") != nil || disk.Get("models.custom_soft_value") != nil {
		t.Fatal("managed model projection or overlay separation lost")
	}
}

// Differential native discovery only: no login, inference, hook or MCP execution.
func TestRuntimeNativeInspectDoesNotActivateOverlayDiscovery(t *testing.T) {
	binary := os.Getenv("CXX_TEST_GROK_BIN")
	if binary == "" {
		t.Skip("set CXX_TEST_GROK_BIN to a native Grok binary to run")
	}
	for _, mode := range []string{"inline", "json", "toml"} {
		t.Run(mode, func(t *testing.T) {
			r := runtimeWithBase(t, func(base string) {
				writeBaseAsset(t, base, "config.toml", "[mcp_servers.disk-server]\ncommand = \"/bin/false\"\n", 0o600)
			})
			body := `{"models":{"default":"grok-4.7","default_reasoning_effort":"low"},"mcp_servers":{"overlay-server":{"command":"/bin/false"}},"sandbox":{"profile":"read-only"}}`
			if mode == "inline" {
				t.Setenv("GROK_CONFIG", body)
			} else {
				if mode == "toml" {
					body = "[models]\ndefault = \"grok-4.7\"\ndefault_reasoning_effort = \"low\"\n[mcp_servers.overlay-server]\ncommand = \"/bin/false\"\n[sandbox]\nprofile = \"read-only\"\n"
				}
				path := filepath.Join(t.TempDir(), "overlay."+mode)
				if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
					t.Fatal(err)
				}
				t.Setenv("GROK_CONFIG_PATH", path)
			}
			inspect := func(env []string) map[string]any {
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				cmd := exec.CommandContext(ctx, binary, "inspect", "--json")
				cmd.Dir = filepath.Dir(r.BaseHome)
				cmd.Env = env
				out, err := cmd.Output()
				if err != nil {
					t.Fatalf("native inspect: %v", err)
				}
				var doc map[string]any
				if err := json.Unmarshal(out, &doc); err != nil {
					t.Fatal(err)
				}
				return doc
			}
			baseEnv := []string{"PATH=/usr/bin:/bin", "HOME=" + filepath.Dir(r.BaseHome), "GROK_HOME=" + r.BaseHome, "GROK_DISABLE_AUTOUPDATER=1", "TERM=dumb", "GROK_CONFIG=" + os.Getenv("GROK_CONFIG"), "GROK_CONFIG_PATH=" + os.Getenv("GROK_CONFIG_PATH")}
			before := inspect(baseEnv)
			if err := r.Configure("/fixture/cxx", &config.Config{}, false); err != nil {
				t.Fatal(err)
			}
			after := inspect(r.Environment(baseEnv))
			var overlayNotes []string
			for _, doc := range []map[string]any{before, after} {
				servers, _ := doc["mcpServers"].([]any)
				if len(servers) != 1 || servers[0].(map[string]any)["name"] != "disk-server" {
					t.Fatal("native overlay discovery differs from authored disk discovery")
				}
				sources := doc["configSources"].(map[string]any)
				layers, _ := sources["layers"].([]any)
				for _, layer := range layers {
					entry := layer.(map[string]any)
					if entry["role"] == "env_overlay" {
						note, _ := entry["note"].(string)
						overlayNotes = append(overlayNotes, note)
					}
				}
			}
			if len(overlayNotes) != 2 || overlayNotes[0] != overlayNotes[1] || !strings.Contains(overlayNotes[0], "models") || strings.Contains(overlayNotes[0], "mcp_servers") || strings.Contains(overlayNotes[0], "sandbox") {
				t.Fatalf("native soft-layer filtering differs: %v", overlayNotes)
			}
		})
	}
}

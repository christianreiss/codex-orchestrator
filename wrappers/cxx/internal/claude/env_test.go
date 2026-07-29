package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func testRuntimeConfig() *config.Config {
	return &config.Config{
		Orchestrator: config.Orchestrator{BaseURL: "https://orch.example", APIKey: "host-key"},
		Host:         config.Host{ID: 7, FQDN: "host.example"},
		Wrapper:      config.Wrapper{Version: "0.6.19"},
	}
}

func writeRuntimeCredentials(t *testing.T, raw string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
}

func envValues(env []string, name string) []string {
	prefix := name + "="
	var out []string
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			out = append(out, strings.TrimPrefix(item, prefix))
		}
	}
	return out
}

func TestBuildEnvOAuthStripsAmbientCredentialAndProviderOverrides(t *testing.T) {
	writeRuntimeCredentials(t, `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-native","refreshToken":"refresh-native"}}`)
	for _, name := range runtimeAuthOverrideEnv {
		t.Setenv(name, "hostile-"+name)
	}

	env := BuildEnv(testRuntimeConfig())
	for _, name := range runtimeAuthOverrideEnv {
		if name == "CLAUDE_CONFIG_DIR" {
			if values := envValues(env, name); len(values) != 0 {
				t.Errorf("%s=%q, want absent so Claude preserves its existing interactive state", name, values)
			}
			continue
		}
		if values := envValues(env, name); len(values) != 0 {
			t.Errorf("%s survived OAuth child environment: %q", name, values)
		}
	}
}

func TestBuildEnvManagedAPIKeyReplacesAmbientKey(t *testing.T) {
	writeRuntimeCredentials(t, `{"api_key":"sk-ant-api03-managed"}`)
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-api03-ambient")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "ambient-bearer")
	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "1")

	env := BuildEnv(testRuntimeConfig())
	if values := envValues(env, "ANTHROPIC_API_KEY"); len(values) != 1 || values[0] != "sk-ant-api03-managed" {
		t.Fatalf("managed API key did not replace ambient key: %q", values)
	}
	for _, name := range []string{"ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"} {
		if values := envValues(env, name); len(values) != 0 {
			t.Errorf("%s survived API-key child environment: %q", name, values)
		}
	}
}

func TestRuntimeAuthSettingsNeutralizeSettingsSources(t *testing.T) {
	writeRuntimeCredentials(t, `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-native","refreshToken":"refresh-native"}}`)
	raw, err := runtimeAuthSettingsJSON(nil)
	if err != nil {
		t.Fatal(err)
	}
	var settings struct {
		APIKeyHelper string            `json:"apiKeyHelper"`
		Env          map[string]string `json:"env"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	if settings.APIKeyHelper != "" {
		t.Fatalf("apiKeyHelper=%q, want disabled", settings.APIKeyHelper)
	}
	if _, ok := settings.Env["CLAUDE_CONFIG_DIR"]; ok {
		t.Fatal("runtime auth settings must not override CLAUDE_CONFIG_DIR")
	}
	for _, name := range runtimeAuthOverrideEnv {
		if name == "CLAUDE_CONFIG_DIR" {
			continue
		}
		want := ""
		if _, provider := runtimeProviderSelectors[name]; provider {
			want = "0"
		}
		if name == "ANTHROPIC_BASE_URL" {
			want = officialAnthropicBaseURL
		}
		if got := settings.Env[name]; got != want {
			t.Errorf("settings env %s=%q want %q", name, got, want)
		}
	}
}

func TestRuntimeAuthSettingsCarryOnlyManagedAPIKey(t *testing.T) {
	writeRuntimeCredentials(t, `{
		"api_key":"sk-ant-api03-managed",
		"anthropic_api_key":"sk-ant-api03-stale",
		"auths":{"api.anthropic.com":{"token":"sk-ant-api03-stale-auths"}}
	}`)
	raw, err := runtimeAuthSettingsJSON(nil)
	if err != nil {
		t.Fatal(err)
	}
	var settings struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	if got := settings.Env["ANTHROPIC_API_KEY"]; got != "sk-ant-api03-managed" {
		t.Fatalf("overlay API key=%q", got)
	}
	if got := settings.Env["ANTHROPIC_AUTH_TOKEN"]; got != "" {
		t.Fatalf("overlay retained bearer override %q", got)
	}
}

func TestInjectRuntimeAuthSettingsOrdering(t *testing.T) {
	if got := injectRuntimeAuthSettings([]string{"auth", "login"}, "/dev/fd/3"); strings.Join(got, " ") != "--settings /dev/fd/3 auth login" {
		t.Fatalf("subcommand overlay order=%q", got)
	}
	if got := injectRuntimeAuthSettings([]string{"--debug", "--settings", "hostile.json", "auth", "status"}, "managed.json"); strings.Join(got, " ") != "--debug --settings hostile.json --settings managed.json auth status" {
		t.Fatalf("global-option subcommand overlay order=%q", got)
	}
	if got := injectRuntimeAuthSettings([]string{"-p", "hello"}, "/dev/fd/3"); strings.Join(got, " ") != "-p hello --settings /dev/fd/3" {
		t.Fatalf("root-command overlay order=%q", got)
	}
	if got := injectRuntimeAuthSettings([]string{"-p", "--", "hello"}, "managed.json"); strings.Join(got, " ") != "-p --settings managed.json -- hello" {
		t.Fatalf("literal-separator overlay order=%q", got)
	}
}

func TestInteractiveAuthLoginOmitsManagedAPIKey(t *testing.T) {
	writeRuntimeCredentials(t, `{"api_key":"sk-ant-api03-managed"}`)
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-api03-ambient")

	env := buildEnv(testRuntimeConfig(), []string{"auth", "login"})
	if values := envValues(env, "ANTHROPIC_API_KEY"); len(values) != 0 {
		t.Fatalf("auth login inherited selected or ambient API key: %q", values)
	}
	raw, err := runtimeAuthSettingsJSON([]string{"--debug", "auth", "login"})
	if err != nil {
		t.Fatal(err)
	}
	var settings struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	if got := settings.Env["ANTHROPIC_API_KEY"]; got != "" {
		t.Fatalf("auth login settings carried managed API key %q", got)
	}
}

func TestOAuthBareIsRewrittenButAPIKeyBareIsPreserved(t *testing.T) {
	writeRuntimeCredentials(t, `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-native","refreshToken":"refresh-native"}}`)
	got, changed := normalizeRuntimeAuthArgs([]string{"-p", "hello", "--bare"})
	if !changed || strings.Join(got, " ") != "-p hello --safe-mode" {
		t.Fatalf("OAuth bare rewrite=%q changed=%v", got, changed)
	}
	got, changed = normalizeRuntimeAuthArgs([]string{"-p", "--", "--bare"})
	if changed || strings.Join(got, " ") != "-p -- --bare" {
		t.Fatalf("literal --bare was rewritten: %q changed=%v", got, changed)
	}
	got, changed = normalizeRuntimeAuthArgs([]string{"--append-system-prompt", "--bare", "-p", "hello"})
	if changed || strings.Join(got, " ") != "--append-system-prompt --bare -p hello" {
		t.Fatalf("option value --bare was rewritten: %q changed=%v", got, changed)
	}

	writeRuntimeCredentials(t, `{"api_key":"sk-ant-api03-managed"}`)
	got, changed = normalizeRuntimeAuthArgs([]string{"--bare", "-p", "hello"})
	if changed || strings.Join(got, " ") != "--bare -p hello" {
		t.Fatalf("API-key bare changed: %q changed=%v", got, changed)
	}
}

func TestPrepareRuntimeAuthSettingsKeepsSecretOutOfArgvAndCleansUp(t *testing.T) {
	writeRuntimeCredentials(t, `{"api_key":"sk-ant-api03-managed"}`)
	args, cleanup, err := prepareRuntimeAuthSettings([]string{"-p", "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(args, " "), "sk-ant-api03-managed") {
		t.Fatalf("managed key leaked in argv: %q", args)
	}
	var settingsPath string
	for i, arg := range args {
		if arg == "--settings" && i+1 < len(args) {
			settingsPath = args[i+1]
			break
		}
	}
	if settingsPath == "" {
		t.Fatalf("runtime settings path missing from argv: %q", args)
	}
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "sk-ant-api03-managed") {
		t.Fatal("protected runtime settings omitted managed API key")
	}
	info, err := os.Stat(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("runtime settings mode=%o want 600", info.Mode().Perm())
	}
	cleanup()
	if _, err := os.Stat(settingsPath); !os.IsNotExist(err) {
		t.Fatalf("runtime settings survived cleanup: %v", err)
	}
}

func TestPrepareRuntimeAuthSettingsPrunesOnlyStaleFiles(t *testing.T) {
	writeRuntimeCredentials(t, `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-native","refreshToken":"refresh-native"}}`)
	dir, err := runtimeAuthSettingsDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, "settings-stale.json")
	fresh := filepath.Join(dir, "settings-fresh.json")
	for _, path := range []string{stale, fresh} {
		if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-staleRuntimeAuthSettingsAge - time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	_, cleanup, err := prepareRuntimeAuthSettings(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale runtime auth settings survived: %v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("fresh runtime auth settings removed: %v", err)
	}
}

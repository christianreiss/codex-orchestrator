package claude

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Claude Code ranks Anthropic profile / workload-identity-federation sources
// above the subscription OAuth login (authentication.md, "Authentication
// precedence"). These selectors must therefore be neutralised exactly like the
// sibling ANTHROPIC_IDENTITY_TOKEN* variables.
var profileSelectorEnv = []string{
	"ANTHROPIC_PROFILE",
	"ANTHROPIC_FEDERATION_RULE_ID",
	"ANTHROPIC_ORGANIZATION_ID",
	"ANTHROPIC_WORKSPACE_ID",
	"ANTHROPIC_SERVICE_ACCOUNT_ID",
}

const (
	oauthCredentialsFixture  = `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-native","refreshToken":"refresh-native"}}`
	apiKeyCredentialsFixture = `{"api_key":"sk-ant-api03-managed"}`
)

func overlayEnv(t *testing.T, args []string) map[string]string {
	t.Helper()
	raw, err := runtimeAuthSettingsJSON(args)
	if err != nil {
		t.Fatal(err)
	}
	var settings struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	return settings.Env
}

func TestProfileSelectorsAreRuntimeAuthOverrides(t *testing.T) {
	listed := map[string]bool{}
	for _, name := range runtimeAuthOverrideEnv {
		listed[name] = true
	}
	for _, name := range append([]string{"ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE"}, profileSelectorEnv...) {
		if !listed[name] {
			t.Errorf("%s missing from runtimeAuthOverrideEnv", name)
		}
	}
	// ANTHROPIC_CONFIG_DIR is a known, documented gap (see docs/interface-clx.md,
	// 2026-11-20): redirecting it would also move `ant` and Console-keyless
	// profile state for every subprocess the session starts.
	if listed["ANTHROPIC_CONFIG_DIR"] {
		t.Error("ANTHROPIC_CONFIG_DIR must not be neutralised without the exemptions documented in docs/interface-clx.md")
	}
}

func TestRuntimeAuthSettingsBlankProfileSelectorsInEveryMode(t *testing.T) {
	cases := []struct {
		name        string
		credentials string
		args        []string
	}{
		{"oauth", oauthCredentialsFixture, nil},
		{"oauth print", oauthCredentialsFixture, []string{"-p", "hi"}},
		{"oauth interactive login", oauthCredentialsFixture, []string{"login"}},
		{"oauth auth login", oauthCredentialsFixture, []string{"auth", "login"}},
		{"oauth bare", oauthCredentialsFixture, []string{"--bare", "-p", "hi"}},
		{"api key", apiKeyCredentialsFixture, nil},
		{"api key interactive login", apiKeyCredentialsFixture, []string{"auth", "login"}},
		{"api key bare", apiKeyCredentialsFixture, []string{"--bare", "-p", "hi"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			writeRuntimeCredentials(t, tc.credentials)
			env := overlayEnv(t, tc.args)
			for _, name := range profileSelectorEnv {
				got, ok := env[name]
				if !ok || got != "" {
					t.Errorf("overlay env %s=%q (present=%v), want present and blank", name, got, ok)
				}
			}
			if _, ok := env["ANTHROPIC_CONFIG_DIR"]; ok {
				t.Error("overlay must not touch ANTHROPIC_CONFIG_DIR")
			}
		})
	}
}

func TestBuildEnvStripsProfileSelectorsInEveryMode(t *testing.T) {
	cases := []struct {
		name        string
		credentials string
		args        []string
		wantAPIKey  string // "" means ANTHROPIC_API_KEY must be absent
	}{
		{"oauth", oauthCredentialsFixture, nil, ""},
		{"oauth print", oauthCredentialsFixture, []string{"-p", "hi"}, ""},
		{"oauth interactive login", oauthCredentialsFixture, []string{"login"}, ""},
		{"oauth auth login", oauthCredentialsFixture, []string{"auth", "login"}, ""},
		{"oauth bare", oauthCredentialsFixture, []string{"--bare", "-p", "hi"}, ""},
		{"api key", apiKeyCredentialsFixture, nil, "sk-ant-api03-managed"},
		{"api key interactive login", apiKeyCredentialsFixture, []string{"auth", "login"}, ""},
		{"api key bare", apiKeyCredentialsFixture, []string{"--bare", "-p", "hi"}, "sk-ant-api03-managed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			writeRuntimeCredentials(t, tc.credentials)
			for _, name := range profileSelectorEnv {
				t.Setenv(name, "hostile-"+name)
			}
			t.Setenv("ANTHROPIC_IDENTITY_TOKEN", "hostile-identity")
			t.Setenv("ANTHROPIC_CONFIG_DIR", "/hostile/config-dir")

			env := buildEnv(testRuntimeConfig(), tc.args)
			for _, name := range append([]string{"ANTHROPIC_IDENTITY_TOKEN"}, profileSelectorEnv...) {
				if values := envValues(env, name); len(values) != 0 {
					t.Errorf("%s survived child environment: %q", name, values)
				}
			}
			// Behaviour untouched by this change: the ambient value of the
			// known-gap variable passes through.
			if values := envValues(env, "ANTHROPIC_CONFIG_DIR"); len(values) != 1 || values[0] != "/hostile/config-dir" {
				t.Errorf("ANTHROPIC_CONFIG_DIR=%q, want passthrough", values)
			}
			values := envValues(env, "ANTHROPIC_API_KEY")
			switch {
			case tc.wantAPIKey == "" && len(values) != 0:
				t.Errorf("ANTHROPIC_API_KEY=%q, want absent", values)
			case tc.wantAPIKey != "" && (len(values) != 1 || values[0] != tc.wantAPIKey):
				t.Errorf("ANTHROPIC_API_KEY=%q, want %q", values, tc.wantAPIKey)
			}
		})
	}
}

// The five selectors must be treated exactly like ANTHROPIC_IDENTITY_TOKEN in
// every mode: same overlay value, same stripping, same exemptions.
func TestProfileSelectorsMirrorIdentityTokenHandling(t *testing.T) {
	for _, tc := range []struct {
		name        string
		credentials string
		args        []string
	}{
		{"oauth", oauthCredentialsFixture, nil},
		{"oauth login", oauthCredentialsFixture, []string{"auth", "login"}},
		{"api key", apiKeyCredentialsFixture, nil},
		{"api key login", apiKeyCredentialsFixture, []string{"login"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			writeRuntimeCredentials(t, tc.credentials)
			env := overlayEnv(t, tc.args)
			wantVal, wantPresent := env["ANTHROPIC_IDENTITY_TOKEN"]
			for _, name := range profileSelectorEnv {
				if got, ok := env[name]; ok != wantPresent || got != wantVal {
					t.Errorf("overlay %s=(%q,%v), identity token=(%q,%v)", name, got, ok, wantVal, wantPresent)
				}
			}
			t.Setenv("ANTHROPIC_IDENTITY_TOKEN", "x")
			for _, name := range profileSelectorEnv {
				t.Setenv(name, "x")
			}
			built := buildEnv(testRuntimeConfig(), tc.args)
			wantEnv := len(envValues(built, "ANTHROPIC_IDENTITY_TOKEN"))
			for _, name := range profileSelectorEnv {
				if got := len(envValues(built, name)); got != wantEnv {
					t.Errorf("BuildEnv keeps %d copies of %s, identity token keeps %d", got, name, wantEnv)
				}
			}
		})
	}
}

func TestBareStillRewritesToSafeModeWithProfileSelectors(t *testing.T) {
	writeRuntimeCredentials(t, oauthCredentialsFixture)
	got, changed := normalizeRuntimeAuthArgs([]string{"--bare", "-p", "hi"})
	if !changed || len(got) != 3 || got[0] != "--safe-mode" {
		t.Fatalf("normalizeRuntimeAuthArgs = %q changed=%v, want --bare rewritten to --safe-mode", got, changed)
	}
}

func TestFilterEnvStripsProfileSelectorsAndKeepsOthers(t *testing.T) {
	in := []string{
		"PATH=/usr/bin",
		"ANTHROPIC_PROFILE=p",
		"ANTHROPIC_FEDERATION_RULE_ID=r",
		"ANTHROPIC_ORGANIZATION_ID=o",
		"ANTHROPIC_WORKSPACE_ID=w",
		"ANTHROPIC_SERVICE_ACCOUNT_ID=s",
		"ANTHROPIC_MODEL=m",
	}
	out := filterEnv(in, runtimeAuthOverrideEnv)
	if strings.Join(out, ",") != "PATH=/usr/bin,ANTHROPIC_MODEL=m" {
		t.Fatalf("filterEnv = %q", out)
	}
}

// TestNativeOracleProfileSelectorsLoseToFleetLogin runs the real native binary
// named by NATIVE_CLAUDE_ORACLE against a throwaway HOME that holds only a
// FABRICATED subscription credential (no real credential is read or copied).
// `claude auth status --text` prints "Login method: ..." when the stored
// subscription login is the credential in use and a "Profile: ..." row when an
// Anthropic profile / federation source wins. The test builds the real overlay
// (prepareRuntimeAuthSettingsForCLI), and first proves with negative controls
// that each selector WOULD switch the source without the overlay.
func TestNativeOracleProfileSelectorsLoseToFleetLogin(t *testing.T) {
	oracle := os.Getenv("NATIVE_CLAUDE_ORACLE")
	if oracle == "" {
		t.Skip("NATIVE_CLAUDE_ORACLE not set")
	}
	if _, err := os.Stat(oracle); err != nil {
		t.Fatalf("NATIVE_CLAUDE_ORACLE: %v", err)
	}

	selectorSets := []struct {
		name string
		env  map[string]string
	}{
		{"named profile", map[string]string{"ANTHROPIC_PROFILE": "named"}},
		{"federation variables", map[string]string{
			"ANTHROPIC_FEDERATION_RULE_ID": "fdrl_fabricated",
			"ANTHROPIC_ORGANIZATION_ID":    "00000000-0000-0000-0000-000000000000",
		}},
		{"federation with workspace and service account", map[string]string{
			"ANTHROPIC_FEDERATION_RULE_ID": "fdrl_fabricated",
			"ANTHROPIC_ORGANIZATION_ID":    "00000000-0000-0000-0000-000000000000",
			"ANTHROPIC_WORKSPACE_ID":       "wrkspc_fabricated",
			"ANTHROPIC_SERVICE_ACCOUNT_ID": "svac_fabricated",
		}},
		{"all five", map[string]string{
			"ANTHROPIC_PROFILE":            "named",
			"ANTHROPIC_FEDERATION_RULE_ID": "fdrl_fabricated",
			"ANTHROPIC_ORGANIZATION_ID":    "00000000-0000-0000-0000-000000000000",
			"ANTHROPIC_WORKSPACE_ID":       "wrkspc_fabricated",
			"ANTHROPIC_SERVICE_ACCOUNT_ID": "svac_fabricated",
		}},
	}

	// newHome builds a throwaway HOME with fabricated credentials, a
	// fabricated federation profile named "named", and optional user settings.
	newHome := func(t *testing.T, userSettingsEnv map[string]string) string {
		t.Helper()
		home := t.TempDir()
		t.Setenv("HOME", home)
		claudeDir := filepath.Join(home, ".claude")
		must := func(err error) {
			t.Helper()
			if err != nil {
				t.Fatal(err)
			}
		}
		must(os.MkdirAll(claudeDir, 0o700))
		must(os.WriteFile(filepath.Join(claudeDir, ".credentials.json"), []byte(`{"claudeAiOauth":{"accessToken":"sk-ant-oat01-fabricated","refreshToken":"sk-ant-ort01-fabricated","expiresAt":4102444800000,"scopes":["user:inference","user:profile"],"subscriptionType":"max"}}`), 0o600))
		cfgDir := filepath.Join(home, ".config", "anthropic", "configs")
		must(os.MkdirAll(cfgDir, 0o700))
		must(os.WriteFile(filepath.Join(cfgDir, "named.json"), []byte(`{"version":"1.0","authentication":{"type":"oidc_federation","federation_rule_id":"fdrl_fabricated","identity_token":{"source":"file","path":"/nonexistent/token"}},"organization_id":"00000000-0000-0000-0000-000000000000","base_url":"https://api.anthropic.com"}`), 0o600))
		if userSettingsEnv != nil {
			raw, err := json.Marshal(map[string]any{"env": userSettingsEnv})
			must(err)
			must(os.WriteFile(filepath.Join(claudeDir, "settings.json"), raw, 0o600))
		}
		return home
	}

	baseEnv := func(home string) []string {
		return []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + home,
			"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
			"DISABLE_TELEMETRY=1",
			"DISABLE_AUTOUPDATER=1",
		}
	}
	toEnv := func(m map[string]string) []string {
		var out []string
		for k, v := range m {
			out = append(out, k+"="+v)
		}
		return out
	}

	status := func(t *testing.T, env, args []string) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, oracle, args...)
		cmd.Env = env
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("oracle %q failed: %v\n%s", args, err, out)
		}
		return string(out)
	}
	statusArgs := []string{"auth", "status", "--text"}

	for _, sel := range selectorSets {
		for _, via := range []string{"process env", "user settings env"} {
			t.Run(sel.name+"/"+via, func(t *testing.T) {
				var userSettings map[string]string
				if via == "user settings env" {
					userSettings = sel.env
				}
				home := newHome(t, userSettings)

				procEnv := baseEnv(home)
				if via == "process env" {
					procEnv = append(procEnv, toEnv(sel.env)...)
				}

				// Negative control: without the overlay the selector wins.
				control := status(t, procEnv, statusArgs)
				if !strings.Contains(control, "Profile:") {
					t.Fatalf("negative control: selector %v via %s did not select a profile source; output:\n%s", sel.env, via, control)
				}

				// Real overlay (and, for process env, the real stripping).
				wrapped := procEnv
				if via == "process env" {
					wrapped = filterEnv(procEnv, runtimeAuthOverrideEnv)
				}
				args, cleanup, err := prepareRuntimeAuthSettingsForCLI(statusArgs, "")
				if err != nil {
					t.Fatal(err)
				}
				defer cleanup()
				got := status(t, wrapped, args)
				if strings.Contains(got, "Profile:") || !strings.Contains(got, "Login method:") {
					t.Errorf("fleet login lost to selector %v via %s (stripped env + overlay); output:\n%s", sel.env, via, got)
				}

				// The overlay alone (inherited env NOT stripped) must also win,
				// because Claude applies settings env after process startup.
				if via == "process env" {
					got := status(t, procEnv, args)
					if strings.Contains(got, "Profile:") || !strings.Contains(got, "Login method:") {
						t.Errorf("overlay alone lost to inherited selector %v; output:\n%s", sel.env, got)
					}
				}
			})
		}
	}
}

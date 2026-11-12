package kimi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/pelletier/go-toml"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == PrivateReaperCommand {
		os.Exit(RunPrivateReaper(os.Args[2:]))
	}
	os.Exit(m.Run())
}
func accessEnvelope(token string) json.RawMessage {
	raw, _ := json.Marshal(AuthEnvelope{KimiCode: Credential{Key: token, Scope: "kimi-code", TokenType: "Bearer"}, DeviceID: strings.Repeat("a", 32)})
	return raw
}
func TestProjectionRejectsRefreshSecretsAndRewritesAccessFile(t *testing.T) {
	home := t.TempDir()
	r := &Runtime{Home: home, AuthPath: filepath.Join(home, "credentials", "kimi-code.json")}
	for _, token := range []string{"first-access", "second-access"} {
		if err := r.Apply(accessEnvelope(token), 0); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(r.AuthPath)
		if err != nil {
			t.Fatal(err)
		}
		var c Credential
		if json.Unmarshal(raw, &c) != nil || c.Key != token || c.ExpiresAt != 0 || c.ExpiresIn != 0 || c.RefreshToken != "" {
			t.Fatalf("bad projection %s", raw)
		}
		for _, path := range []string{r.AuthPath, filepath.Join(home, "device_id")} {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatal(path, info, err)
			}
		}
	}
	var e AuthEnvelope
	_ = json.Unmarshal(accessEnvelope("access"), &e)
	e.KimiCode.RefreshToken = "must-never-reach-runtime"
	raw, _ := json.Marshal(e)
	if err := r.Apply(raw, 0); err == nil {
		t.Fatal("accepted refresh token")
	}
	e.KimiCode.RefreshToken = ""
	e.KimiCode.ExpiresAt = 1
	raw, _ = json.Marshal(e)
	if err := r.Apply(raw, 0); err == nil {
		t.Fatal("accepted refreshable expiry")
	}
}
func TestRefreshAppliesCanonicalSuccessor(t *testing.T) {
	home := t.TempDir()
	r := &Runtime{Home: home, Dir: t.TempDir(), AuthPath: filepath.Join(home, "credentials", "kimi-code.json"), Pool: &accountpool.Context{AccountID: 7}}
	token := "first"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		sum := sha256.Sum256([]byte(token))
		_ = json.NewEncoder(w).Encode(Projection{AccountID: 7, Auth: accessEnvelope(token), VerificationState: "verified", CanonicalGeneration: 2, AccessTokenDigest: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	}))
	defer server.Close()
	r.Client = &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	if err := r.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	token = "successor"
	if err := r.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(r.AuthPath)
	if !strings.Contains(string(raw), "successor") {
		t.Fatal("runtime did not converge")
	}
}
func TestPrivateHomeKeepsDurableSessionsAndDropsCredentials(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	base := t.TempDir()
	if err := os.WriteFile(filepath.Join(base, "AGENTS.md"), []byte("fleet"), 0600); err != nil {
		t.Fatal(err)
	}
	r, err := NewRuntime(base, &config.Config{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(accessEnvelope("private-access"), 0); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.Home, "sessions", "session-evidence"), []byte("history"), 0600); err != nil {
		t.Fatal(err)
	}
	dir := r.Dir
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("private auth directory retained")
	}
	if _, err := os.Stat(filepath.Join(base, "sessions", "session-evidence")); err != nil {
		t.Fatal("durable transcript lost", err)
	}
	if _, err := os.Stat(filepath.Join(base, "credentials")); !os.IsNotExist(err) {
		t.Fatal("credentials leaked to durable home")
	}
}
func TestConfigureKimiContractAndOwnedConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	home := t.TempDir()
	body := []byte("default_model='kimi-code/test'\ntelemetry=false\n[user]\ncolor='amber'\n[mcp_servers.fleet]\nurl='https://fleet.invalid/mcp'\n")
	if err := SyncConfig(home, body, []string{"default_model", "telemetry", "mcp_servers.fleet"}); err != nil {
		t.Fatal(err)
	}
	effort := "max"
	r := &Runtime{Home: home, BaseHome: home}
	if err := r.Configure("/usr/bin/cxx", &config.Config{EngineOptions: config.EngineOptions{KimiReasoningEffortOverride: &effort}}, true); err != nil {
		t.Fatal(err)
	}
	if bin := os.Getenv("CKX_TEST_NATIVE_BIN"); bin != "" {
		cmd := exec.Command(bin, "doctor", "config", filepath.Join(home, "config.toml"))
		cmd.Env = r.Environment(os.Environ())
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("native config validation: %v: %s", err, out)
		}
	}
	tree, err := toml.LoadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]any{"telemetry": false, "auto_session_title": false, "disable_feedback_survey": true, "thinking.effort": "max", "user.color": "amber", "default_model": "kimi-code/test"} {
		if got := tree.Get(key); got != want {
			t.Fatalf("%s=%v want %v", key, got, want)
		}
	}
	if got := tree.GetPath([]string{"providers", "managed:kimi-code", "oauth", "key"}); got != "oauth/kimi-code" {
		t.Fatal(got)
	}
	raw, _ := os.ReadFile(filepath.Join(home, "config.toml"))
	for _, event := range []string{"UserPromptSubmit", "Stop"} {
		if !strings.Contains(string(raw), "agent poll --hook "+event+" --dialect kimi") {
			t.Fatal("missing hook", event)
		}
	}
	raw, _ = os.ReadFile(filepath.Join(home, "mcp.json"))
	var m struct {
		Servers map[string]any `json:"mcpServers"`
	}
	if json.Unmarshal(raw, &m) != nil || m.Servers["fleet"] == nil || m.Servers["cxx-agent"] == nil {
		t.Fatal("missing MCP servers", string(raw))
	}
	env := r.Environment([]string{"KIMI_API_KEY=foreign", "KIMI_CODE_HOME=wrong"})
	joined := strings.Join(env, "\n")
	for _, want := range []string{"KIMI_CODE_HOME=" + home, "KIMI_DISABLE_TELEMETRY=1", "KIMI_CODE_NO_AUTO_UPDATE=1"} {
		if !strings.Contains(joined, want) {
			t.Fatal(want)
		}
	}
	if strings.Contains(joined, "foreign") {
		t.Fatal("ambient provider credential retained")
	}
}

func TestGlobalProjectionMatchesNativeScopedCredential(t *testing.T) {
	home := t.TempDir()
	r := &Runtime{Home: home, AuthPath: filepath.Join(home, "credentials", "kimi-code.json")}
	var envelope AuthEnvelope
	_ = json.Unmarshal(accessEnvelope("first"), &envelope)
	envelope.DeviceID = "11111111-1111-4111-8111-111111111111"
	envelope.OAuthHost, envelope.BaseURL = "https://auth.kimi.ai", "https://api.kimi.ai/coding/v1"
	// Independently derived with node:crypto over JSON.stringify({oauthHost,baseUrl}).
	const key = "oauth/kimi-code-env-0e4f99c69cc27850"
	for _, token := range []string{"first", "successor"} {
		envelope.KimiCode.Key = token
		raw, _ := json.Marshal(envelope)
		if err := r.Apply(raw, 0); err != nil {
			t.Fatal(err)
		}
		if err := r.Configure("/usr/bin/cxx", &config.Config{}, true); err != nil {
			t.Fatal(err)
		}
		tree, err := toml.LoadFile(filepath.Join(home, "config.toml"))
		if err != nil {
			t.Fatal(err)
		}
		for field, want := range map[string]string{"base_url": envelope.BaseURL, "oauth.key": key, "oauth.oauth_host": envelope.OAuthHost} {
			if got := tree.GetPath(append([]string{"providers", "managed:kimi-code"}, strings.Split(field, ".")...)); got != want {
				t.Fatalf("%s = %v, want %s", field, got, want)
			}
		}
		plain, _ := os.ReadFile(r.AuthPath)
		scoped := filepath.Join(home, "credentials", strings.TrimPrefix(key, "oauth/")+".json")
		got, err := os.ReadFile(scoped)
		if err != nil || string(got) != string(plain) {
			t.Fatalf("scoped credential differs: %s, %v", got, err)
		}
		info, err := os.Stat(scoped)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("scoped credential permissions", err)
		}
		device, _ := os.ReadFile(filepath.Join(home, "device_id"))
		if string(device) != envelope.DeviceID {
			t.Fatal("device id changed")
		}
	}
	checkNativeConfig(t, r)
	for _, pair := range [][2]string{{"https://auth.kimi.ai", "https://api.kimi.com/coding/v1"}, {"https://evil.invalid", "https://api.kimi.ai/coding/v1"}} {
		envelope.OAuthHost, envelope.BaseURL = pair[0], pair[1]
		raw, _ := json.Marshal(envelope)
		if err := r.Apply(raw, 0); err == nil {
			t.Fatal("accepted unsupported endpoint pair", pair)
		}
	}
}

func checkNativeConfig(t *testing.T, r *Runtime) {
	t.Helper()
	if bin := os.Getenv("CKX_TEST_NATIVE_BIN"); bin != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, bin, "doctor", "config", filepath.Join(r.Home, "config.toml"))
		cmd.Env = r.Environment(os.Environ())
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("native config validation: %v: %s", err, out)
		}
	}
}

func TestServerRendererMCPAndHooksGolden(t *testing.T) {
	home := t.TempDir()
	body, err := os.ReadFile("testdata/server-sync.toml")
	if err != nil {
		t.Fatal(err)
	}
	body = append(body, []byte("\n[[hooks]]\nevent='Notification'\ncommand='user-hook'\ntimeout=5\n")...)
	if err := SyncConfig(home, body, []string{"default_model", "models", "providers", "thinking", "mcp_servers"}); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWrite(filepath.Join(home, "mcp.json"), []byte(`{"mcpServers":{"user":{"command":"user-mcp"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	r := &Runtime{Home: home}
	const executable = "/opt/cxx's bin/cxx"
	var first []byte
	for i := 0; i < 2; i++ {
		if err := r.Configure(executable, &config.Config{}, true); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(filepath.Join(home, "config.toml"))
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = got
		} else if string(got) != string(first) {
			t.Fatal("reconfigure duplicates or drops hooks")
		}
		if strings.Contains(string(got), "mcp_servers") {
			t.Fatal("transport-only MCP table retained")
		}
	}
	if os.Getenv("CKX_UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile("testdata/managed-config.golden.toml", first, 0600); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile("testdata/managed-config.golden.toml")
	if err != nil || string(first) != string(want) {
		t.Fatalf("managed config differs from golden: %v\n%s", err, first)
	}
	raw, err := os.ReadFile(filepath.Join(home, "mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Servers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Servers) != 4 || m.Servers["fleet"]["url"] != "https://fleet.invalid/mcp" || m.Servers["local"]["command"] != "/usr/bin/example-mcp" || m.Servers["user"]["command"] != "user-mcp" || m.Servers["cxx-agent"]["command"] != executable {
		t.Fatalf("MCP transport lost: %s", raw)
	}
	if m.Servers["fleet"]["headers"].(map[string]any)["X-API-Key"] != "fixture-only" || m.Servers["local"]["env"].(map[string]any)["MODE"] != "fixture" {
		t.Fatalf("MCP transport details lost: %s", raw)
	}
	checkNativeConfig(t, r)
}

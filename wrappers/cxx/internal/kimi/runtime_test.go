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

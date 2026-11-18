package lifecycle

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/modelpolicy"
)

// The boot card must show the model the fleet policy actually launches and
// must not repeat the rewrite as a loose stderr line; skip-boot keeps it.
func TestLaunchCardShowsPolicyModelWithoutLooseLine(t *testing.T) {
	for _, skipBoot := range []bool{false, true} {
		t.Run(map[bool]string{false: "boot", true: "skip_boot"}[skipBoot], func(t *testing.T) {
			modelpolicy.ResetAnnounced()
			t.Cleanup(modelpolicy.ResetAnnounced)
			home := t.TempDir()
			codexHome := filepath.Join(home, ".codex")
			t.Setenv("HOME", home)
			t.Setenv("CODEX_HOME", codexHome)
			t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "runtime"))
			if err := os.MkdirAll(codexHome, 0o700); err != nil {
				t.Fatal(err)
			}
			os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("model='gpt-6.1-sol'\nmodel_reasoning_effort='medium'\n"), 0o600)
			bin := filepath.Join(home, "bin")
			os.Mkdir(bin, 0o700)
			argsPath := filepath.Join(home, "args")
			t.Setenv("CXX_TEST_ARGS", argsPath)
			script := "#!/bin/sh\ncase \"$1\" in --version|-V) echo 'codex 2.1.1'; exit 0;; esac\nprintf '%s\\n' \"$@\" > \"$CXX_TEST_ARGS\"\n"
			os.WriteFile(filepath.Join(bin, "codex"), []byte(script), 0o700)
			t.Setenv("CDX_CODEX_BIN", filepath.Join(bin, "codex"))
			t.Setenv("PATH", bin)
			stderrPath := filepath.Join(home, "stderr")
			stderr, err := os.Create(stderrPath)
			if err != nil {
				t.Fatal(err)
			}
			defer stderr.Close()
			previous := os.Stderr
			os.Stderr = stderr
			defer func() { os.Stderr = previous }()
			const uuid = "12345678-1234-4123-8123-123456789abc"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.URL.Path == "/host/agent-sessions":
					var body struct {
						SessionID   string `json:"session_id"`
						BridgeToken string `json:"bridge_token"`
					}
					_ = json.NewDecoder(r.Body).Decode(&body)
					_ = json.NewEncoder(w).Encode(map[string]any{"enabled": true, "session_id": body.SessionID, "bridge_token": body.BridgeToken, "agent_address": map[string]any{"name": "Anke", "address": "agent:" + uuid, "binding_generation": 1}})
					t.Setenv("CXX_TEST_SESSION", body.SessionID)
				case strings.HasSuffix(r.URL.Path, "/agent-messaging/self"):
					_ = json.NewEncoder(w).Encode(map[string]any{"identity_version": 1, "name": "Anke", "uuid": uuid, "address": "agent:" + uuid, "session_id": os.Getenv("CXX_TEST_SESSION"), "engine": config.EngineCodex})
				default:
					_, _ = w.Write([]byte(`{}`))
				}
			}))
			defer server.Close()
			effort := "medium"
			cfg := &config.Config{
				Engine:         config.EngineCodex,
				Host:           config.Host{Secure: true, EnginesList: []string{config.EngineCodex}},
				Orchestrator:   config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"},
				AgentMessaging: config.AgentMessaging{Enabled: true},
				EngineOptions: config.EngineOptions{
					ModelPolicy:  &config.ModelPolicy{LatestOnly: true, Replacements: map[string]string{"gpt-6.1-sol": "gpt-6.2-sol", "gpt-6.2-sol": "gpt-6.2-sol"}},
					ModelCatalog: &config.ModelCatalog{DefaultModel: "gpt-6.2-sol", Models: []config.ModelCatalogEntry{{Model: "gpt-6.2-sol", Efforts: []string{"low", "medium"}, DefaultEffort: &effort}}},
				},
			}
			exit, runErr := Run(context.Background(), Options{Config: cfg, SkipAuthSync: true, SkipBoot: skipBoot, Minimal: true, WrapperVersion: "0.9.185", Logger: slog.New(slog.DiscardHandler)})
			if exit != 0 || runErr != nil {
				t.Fatalf("launch = %d, %v", exit, runErr)
			}
			raw, _ := os.ReadFile(argsPath)
			if !strings.Contains(string(raw), "gpt-6.2-sol") {
				t.Fatalf("policy model not launched: %q", raw)
			}
			out, _ := os.ReadFile(stderrPath)
			loose := strings.Contains(string(out), "current models policy")
			if skipBoot != loose {
				t.Fatalf("loose policy line=%v with skipBoot=%v:\n%s", loose, skipBoot, out)
			}
			if !skipBoot && (!strings.Contains(string(out), "model=gpt-6.2-sol") || !strings.Contains(string(out), "policy_from=gpt-6.1-sol")) {
				t.Fatalf("card does not show the launched model:\n%s", out)
			}
		})
	}
}

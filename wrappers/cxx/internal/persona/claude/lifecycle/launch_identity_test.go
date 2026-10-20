package lifecycle

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestLaunchConfirmsManagedIdentityBeforeStartingClaude(t *testing.T) {
	for _, name := range []string{"Claudia", ""} {
		label := "confirmed_name"
		if name == "" {
			label = "missing_name"
		}
		t.Run(label, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
			t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
			t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "runtime"))
			previousRequest := requestBackgroundMaintenance
			requestBackgroundMaintenance = func(string, string) error { return nil }
			t.Cleanup(func() { requestBackgroundMaintenance = previousRequest })

			bin := filepath.Join(home, "bin")
			if err := os.Mkdir(bin, 0o700); err != nil {
				t.Fatal(err)
			}
			ready, marker := filepath.Join(home, "identity-confirmed"), filepath.Join(home, "provider-argv")
			t.Setenv("CXX_TEST_IDENTITY_READY", ready)
			t.Setenv("CXX_TEST_IDENTITY_ARGV", marker)
			cli := filepath.Join(bin, "claude")
			writeTestScript(t, cli, `#!/bin/sh
case "$1" in --version|-V) echo 2.1.1; exit 0;; esac
if [ ! -f "$CXX_TEST_IDENTITY_READY" ]; then
  printf 'started before identity confirmation' > "$CXX_TEST_IDENTITY_ARGV"
  exit 43
fi
printf '%s\000' "$@" > "$CXX_TEST_IDENTITY_ARGV"
`)
			t.Setenv("CLX_CLAUDE_BIN", cli)
			t.Setenv("PATH", bin)
			payload := json.RawMessage(fmt.Sprintf(`{"last_refresh":%q,"claudeAiOauth":{"accessToken":"fixture","expiresAt":%d}}`, time.Now().UTC().Format(time.RFC3339Nano), time.Now().Add(time.Hour).UnixMilli()))
			if err := claude.WriteAuth(payload); err != nil {
				t.Fatal(err)
			}

			const uuid = "12345678-1234-4123-8123-123456789abc"
			var registered atomic.Bool
			var selfCalls atomic.Int32
			var launchID atomic.Value
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.URL.Path == "/sync/bootstrap":
					_, _ = w.Write([]byte(`{"agents":"# fixture fleet","auth":{"status":"valid","verification_state":"verified","host":{"secure":true,"engines_list":["claude"]}}}`))
				case r.URL.Path == "/skills":
					_, _ = w.Write([]byte(`{"skills":[]}`))
				case r.URL.Path == "/auth":
					_, _ = w.Write([]byte(`{"status":"valid","verification_state":"verified","host":{"secure":true}}`))
				case r.URL.Path == "/host/agent-sessions":
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if body["engine"] != config.EngineClaude {
						t.Errorf("registration engine = %v", body["engine"])
					}
					launchID.Store(body["session_id"].(string))
					registered.Store(true)
					_ = json.NewEncoder(w).Encode(map[string]any{"enabled": true, "session_id": body["session_id"], "bridge_token": body["bridge_token"], "agent_address": map[string]any{"name": name, "address": "agent:" + uuid, "binding_generation": 1}})
				case strings.HasSuffix(r.URL.Path, "/agent-messaging/self"):
					selfCalls.Add(1)
					if !registered.Load() {
						t.Error("identity confirmation preceded registration")
					}
					if _, err := os.Stat(marker); !os.IsNotExist(err) {
						t.Error("provider started before identity confirmation")
					}
					if err := os.WriteFile(ready, []byte("confirmed"), 0o600); err != nil {
						t.Error(err)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"identity_version": 1, "name": name, "uuid": uuid, "address": "agent:" + uuid, "session_id": launchID.Load(), "engine": config.EngineClaude})
				default:
					_, _ = w.Write([]byte(`{}`))
				}
			}))
			defer server.Close()
			cfg := &config.Config{
				Engine:         config.EngineClaude,
				Host:           config.Host{Secure: true, EnginesList: []string{config.EngineClaude}},
				Orchestrator:   config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"},
				AgentMessaging: config.AgentMessaging{Enabled: true},
			}
			exit, err := Run(context.Background(), Options{Config: cfg, ExtraArgs: []string{"-p", "Keep this user prompt"}, Headless: true, SkipBoot: true, WrapperVersion: "0.9.24", Logger: slog.New(slog.DiscardHandler)})
			if !registered.Load() {
				t.Fatal("lifecycle skipped agent registration")
			}
			if name == "" {
				if exit != 1 || err == nil || !strings.Contains(err.Error(), "registration has no confirmed name") {
					t.Fatalf("unnamed launch = %d, %v", exit, err)
				}
				if selfCalls.Load() != 0 {
					t.Fatal("unnamed registration reached identity confirmation")
				}
				if _, err := os.Stat(marker); !os.IsNotExist(err) {
					t.Fatalf("unnamed registration started Claude: %v", err)
				}
				return
			}
			if exit != 0 || err != nil || selfCalls.Load() != 1 {
				t.Fatalf("confirmed launch = %d, %v; self calls = %d", exit, err, selfCalls.Load())
			}
			raw, err := os.ReadFile(marker)
			if err != nil {
				t.Fatal(err)
			}
			args := strings.Split(strings.TrimSuffix(string(raw), "\x00"), "\x00")
			for _, want := range []string{"your name is Claudia", "your launch session ID is " + launchID.Load().(string), "agent_self", "Keep this user prompt", "(Claudia)"} {
				if !strings.Contains(strings.Join(args, "\n"), want) {
					t.Errorf("provider arguments omitted %q: %q", want, args)
				}
			}
		})
	}
}

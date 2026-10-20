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
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestLaunchShowsRegisteredNameBeforeFirstCodexPrompt(t *testing.T) {
	for _, tc := range []struct {
		label, name string
		skipBoot    bool
	}{
		{label: "before_first_prompt", name: "Claudia"},
		{label: "skip_boot", name: "Claudia", skipBoot: true},
		{label: "missing_name"},
	} {
		t.Run(tc.label, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
			t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "runtime"))
			bin := filepath.Join(home, "bin")
			if err := os.Mkdir(bin, 0o700); err != nil {
				t.Fatal(err)
			}
			startupPath, marker := filepath.Join(home, "startup-output"), filepath.Join(home, "prompt-ready")
			startup, err := os.Create(startupPath)
			if err != nil {
				t.Fatal(err)
			}
			defer startup.Close()
			previousStderr := os.Stderr
			os.Stderr = startup
			defer func() { os.Stderr = previousStderr }()
			t.Setenv("CXX_TEST_STARTUP_OUTPUT", startupPath)
			t.Setenv("CXX_TEST_PROMPT_READY", marker)
			expectNotice := "yes"
			if tc.skipBoot {
				expectNotice = "no"
			}
			t.Setenv("CXX_TEST_EXPECT_NOTICE", expectNotice)
			cli := filepath.Join(bin, "codex")
			script := `#!/bin/sh
case "$1" in --version|-V) echo 'codex 2.1.1'; exit 0;; esac
seen=no
while IFS= read -r line; do
  case "$line" in *"(Claudia) registered"*) seen=yes;; esac
done < "$CXX_TEST_STARTUP_OUTPUT"
if [ "$seen" != "$CXX_TEST_EXPECT_NOTICE" ]; then
  printf 'registration notice before first prompt: %s' "$seen" > "$CXX_TEST_PROMPT_READY"
  exit 43
fi
printf '%s\000' "$@" > "$CXX_TEST_PROMPT_READY"
`
			if err := os.WriteFile(cli, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CDX_CODEX_BIN", cli)
			t.Setenv("PATH", bin)
			const uuid = "12345678-1234-4123-8123-123456789abc"
			var registered atomic.Bool
			var selfCalls atomic.Int32
			var launchID atomic.Value
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.URL.Path == "/host/agent-sessions":
					var body struct {
						SessionID   string `json:"session_id"`
						BridgeToken string `json:"bridge_token"`
						Engine      string `json:"engine"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					if body.Engine != config.EngineCodex || body.SessionID == "" {
						t.Errorf("invalid registration engine=%q session=%q", body.Engine, body.SessionID)
					}
					launchID.Store(body.SessionID)
					registered.Store(true)
					_ = json.NewEncoder(w).Encode(map[string]any{"enabled": true, "session_id": body.SessionID, "bridge_token": body.BridgeToken, "agent_address": map[string]any{"name": tc.name, "address": "agent:" + uuid, "binding_generation": 1}})
				case strings.HasSuffix(r.URL.Path, "/agent-messaging/self"):
					selfCalls.Add(1)
					if !registered.Load() {
						t.Error("identity confirmation preceded registration")
					}
					if _, err := os.Stat(marker); !os.IsNotExist(err) {
						t.Error("Codex reached its prompt before identity confirmation")
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"identity_version": 1, "name": tc.name, "uuid": uuid, "address": "agent:" + uuid, "session_id": launchID.Load(), "engine": config.EngineCodex})
				default:
					_, _ = w.Write([]byte(`{}`))
				}
			}))
			defer server.Close()
			cfg := &config.Config{
				Engine:         config.EngineCodex,
				Host:           config.Host{Secure: true, EnginesList: []string{config.EngineCodex}},
				Orchestrator:   config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"},
				AgentMessaging: config.AgentMessaging{Enabled: true},
			}
			// No initial user prompt: registration and its visible result must happen
			// before the native CLI starts waiting for the operator's first input.
			exit, runErr := Run(context.Background(), Options{Config: cfg, SkipAuthSync: true, SkipBoot: tc.skipBoot, Minimal: true, WrapperVersion: "0.9.24", Logger: slog.New(slog.DiscardHandler)})
			output, err := os.ReadFile(startupPath)
			if err != nil {
				t.Fatal(err)
			}
			if !registered.Load() {
				t.Fatal("lifecycle skipped registration")
			}
			if tc.name == "" {
				if exit != 1 || runErr == nil || !strings.Contains(runErr.Error(), "registration has no confirmed name") {
					t.Fatalf("unnamed launch = %d, %v", exit, runErr)
				}
				if selfCalls.Load() != 0 || strings.Contains(string(output), "registered") {
					t.Fatalf("unnamed registration was confirmed or advertised: self=%d output=%q", selfCalls.Load(), output)
				}
				if _, err := os.Stat(marker); !os.IsNotExist(err) {
					t.Fatalf("unnamed registration started Codex: %v", err)
				}
				return
			}
			if exit != 0 || runErr != nil || selfCalls.Load() != 1 {
				t.Fatalf("launch = %d, %v; self=%d startup=%q", exit, runErr, selfCalls.Load(), output)
			}
			raw, err := os.ReadFile(marker)
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"your name is Claudia", "your launch session ID is " + launchID.Load().(string), "agent_self"} {
				if !strings.Contains(string(raw), want) {
					t.Errorf("Codex arguments omitted %q: %q", want, raw)
				}
			}
			if visible := strings.Contains(string(output), "(Claudia) registered"); visible == tc.skipBoot {
				t.Fatalf("registration notice visible=%v, SkipBoot=%v: %q", visible, tc.skipBoot, output)
			}
		})
	}
}

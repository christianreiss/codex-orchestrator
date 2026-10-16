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
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/memoryrouting"
)

func TestClaudeLaunchWritesMemoryPointerBeforeNativeAndIgnoresPromptSelectors(t *testing.T) {
	for _, mode := range []string{"settings", "opaque_option", "opaque_sources", "literal_prompt", "communicator_opaque"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			t.Setenv("HOME", root)
			t.Setenv("CODEX_HOME", filepath.Join(root, ".codex"))
			t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "run"))
			foreign := filepath.Join(root, "foreign-config")
			t.Setenv("CLAUDE_CONFIG_DIR", foreign)
			t.Setenv("CLAUDE_CODE_PROJECT_DIR_NAME", "foreign-project")
			t.Setenv("CLAUDE_CODE_MANAGED_SETTINGS_PATH", filepath.Join(root, "absent-policy.json"))
			previous := requestBackgroundMaintenance
			requestBackgroundMaintenance = func(string, string) error { return nil }
			t.Cleanup(func() { requestBackgroundMaintenance = previous })
			selected := filepath.Join(root, "selected-memory")
			path := filepath.Join(selected, "MEMORY.md")
			if err := os.MkdirAll(selected, 0o700); err != nil {
				t.Fatal(err)
			}
			const notes = "existing local memory\r\n"
			if err := os.WriteFile(path, []byte(notes), 0o640); err != nil {
				t.Fatal(err)
			}
			if err := claude.WriteAuth(json.RawMessage(fmt.Sprintf(`{"last_refresh":%q,"claudeAiOauth":{"accessToken":"fixture","expiresAt":%d}}`, time.Now().UTC().Format(time.RFC3339Nano), time.Now().Add(time.Hour).UnixMilli()))); err != nil {
				t.Fatal(err)
			}
			settings, _ := json.Marshal(map[string]string{"autoMemoryDirectory": selected})
			if err := os.WriteFile(filepath.Join(root, ".claude", "settings.json"), settings, 0o600); err != nil {
				t.Fatal(err)
			}
			bogus, _ := json.Marshal(map[string]string{"autoMemoryDirectory": filepath.Join(root, "wrong-memory")})
			args := []string{"--settings", string(settings), "-p", "test"}
			switch mode {
			case "opaque_option", "communicator_opaque":
				args = []string{"--system-prompt", "--settings=" + string(bogus), "-p", "test"}
			case "opaque_sources":
				args = []string{"--system-prompt", "--setting-sources=", "-p", "test"}
			case "literal_prompt":
				args = []string{"--", "--settings=" + string(bogus)}
			}
			marker := filepath.Join(root, "native-launched")
			t.Setenv("CXX_TEST_MEMORY_PATH", path)
			t.Setenv("CXX_TEST_MEMORY_MARKER", marker)
			cli := filepath.Join(root, "claude")
			writeTestScript(t, cli, "#!/bin/sh\ncase \"$1\" in --version|-V) echo 2.1.296;; *) test -z \"$CLAUDE_CONFIG_DIR\" || exit 30\ntest -f \"$CXX_TEST_MEMORY_PATH\" || exit 31\nwhile IFS= read -r line; do case \"$line\" in *cxx:memory-routing:start*) printf ready > \"$CXX_TEST_MEMORY_MARKER\";; esac; done < \"$CXX_TEST_MEMORY_PATH\";; esac\n")
			t.Setenv("CLX_CLAUDE_BIN", cli)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/sync/bootstrap":
					_ = json.NewEncoder(w).Encode(map[string]any{"memory_routing": &memoryrouting.Bundle{Enabled: true, Content: "Use shared_memory_search over MCP"}, "auth": map[string]any{"status": "valid", "verification_state": "verified", "host": map[string]bool{"secure": true}}})
				case "/auth":
					_, _ = w.Write([]byte(`{"status":"valid","verification_state":"verified","host":{"secure":true}}`))
				case "/skills":
					_, _ = w.Write([]byte(`{"skills":[]}`))
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			cfg := &config.Config{Engine: "claude", Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
			if mode == "communicator_opaque" {
				result := CommunicatorWork(context.Background(), cfg, communicator.SyncRequest{Operation: "content", Args: args})
				if result.Error != nil || result.Resources["config"].Err() != nil {
					t.Fatalf("communicator memory sync: %+v", result)
				}
			} else {
				if code, err := Run(context.Background(), Options{Config: cfg, Headless: true, SkipBoot: true, ExtraArgs: args, Logger: slog.New(slog.DiscardHandler)}); code != 0 || err != nil {
					t.Fatalf("launch: %d %v", code, err)
				}
				if body, err := os.ReadFile(marker); err != nil || string(body) != "ready" {
					t.Fatalf("native did not see memory pointer: %q %v", body, err)
				}
			}
			body, err := os.ReadFile(path)
			if err != nil || !strings.HasSuffix(string(body), notes) || strings.Count(string(body), memoryrouting.Start) != 1 {
				t.Fatalf("local memory changed: %q %v", body, err)
			}
			for _, absent := range []string{foreign, filepath.Join(root, "wrong-memory")} {
				if _, err := os.Stat(absent); !os.IsNotExist(err) {
					t.Fatalf("non-native target touched: %s, %v", absent, err)
				}
			}
		})
	}
}

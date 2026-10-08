package memoryrouting_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/memoryrouting"
	clx "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/lifecycle"
	cdx "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/lifecycle"
)

// The content-only lifecycle is shared by foreground startup, sync and cron.
func TestContentOnlyLifecycleConvergesRemindersWithoutCredentials(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		t.Run(engine, func(t *testing.T) {
			root := t.TempDir()
			t.Setenv("HOME", root)
			t.Setenv("CODEX_HOME", filepath.Join(root, ".codex"))
			t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "run"))
			t.Setenv("CODEX_ALLOW_FQDN_MISMATCH", "1")
			bundle := &memoryrouting.Bundle{Enabled: true, Content: "central shared_memory_read"}
			responseCode := ""
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if responseCode != "" {
					w.WriteHeader(http.StatusForbidden)
					_ = json.NewEncoder(w).Encode(map[string]any{"code": responseCode, "scope": "fleet", "message": "fixture refusal"})
					return
				}
				switch r.URL.Path {
				case "/sync/bootstrap":
					var request struct {
						IncludeAuth bool `json:"include_auth"`
					}
					_ = json.NewDecoder(r.Body).Decode(&request)
					if request.IncludeAuth {
						t.Error("reminder sync requested credentials")
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "memory_routing": bundle})
				case "/skills":
					_, _ = io.WriteString(w, `{"skills":[]}`)
				default:
					_, _ = io.WriteString(w, `{"status":"ok"}`)
				}
			}))
			defer server.Close()
			cfg := &config.Config{Engine: engine, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}, Host: config.Host{Secure: true}}
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			custom := filepath.Join(root, "custom-memory")
			run := func() (int, error) {
				if engine == "codex" {
					return cdx.Run(context.Background(), cdx.Options{Config: cfg, SyncOnly: true, SkipCredentialExchange: true, Headless: true, SkipBoot: true, Logger: logger})
				}
				return clx.Run(context.Background(), clx.Options{Config: cfg, SyncOnly: true, SkipCredentialExchange: true, Headless: true, SkipBoot: true, Logger: logger, ExtraArgs: []string{"--settings", `{"autoMemoryDirectory":"` + custom + `"}`}})
			}
			path := filepath.Join(root, ".codex", "memories", "MEMORY.md")
			if engine == "claude" {
				path = filepath.Join(custom, "MEMORY.md")
			}
			for range 2 {
				if exit, err := run(); err != nil || exit != 0 {
					t.Fatalf("content lifecycle: %d %v", exit, err)
				}
			}
			body, err := os.ReadFile(path)
			if err != nil || strings.Count(string(body), memoryrouting.Start) != 1 {
				t.Fatalf("reminder absent or repeated: %q %v", body, err)
			}
			bundle = nil // Older servers must not erase a previously served reminder.
			if exit, err := run(); err != nil || exit != 0 {
				t.Fatalf("older server: %d %v", exit, err)
			}
			unchanged, _ := os.ReadFile(path)
			if string(unchanged) != string(body) {
				t.Fatal("older server erased reminder")
			}
			responseCode = "engine_disabled"
			if exit, err := run(); exit != 1 || err == nil {
				t.Fatalf("suspension accepted: %d %v", exit, err)
			}
			unchanged, _ = os.ReadFile(path)
			if string(unchanged) != string(body) {
				t.Fatal("fleet suspension erased reminder")
			}
			responseCode = "invalid_api_key"
			if exit, err := run(); exit != 1 || err == nil {
				t.Fatalf("host trust loss accepted: %d %v", exit, err)
			}
			unchanged, _ = os.ReadFile(path)
			if strings.Contains(string(unchanged), memoryrouting.Start) {
				t.Fatal("explicit host trust loss left reminder")
			}
			responseCode = ""
			bundle = &memoryrouting.Bundle{}
			if exit, err := run(); err != nil || exit != 0 {
				t.Fatalf("disabled gate: %d %v", exit, err)
			}
			body, _ = os.ReadFile(path)
			if strings.Contains(string(body), memoryrouting.Start) {
				t.Fatal("disabled reminder survived")
			}
			for _, credential := range []string{filepath.Join(root, ".codex", "auth.json"), filepath.Join(root, ".claude", ".credentials.json")} {
				if _, err := os.Stat(credential); !os.IsNotExist(err) {
					t.Fatalf("credential touched: %s", credential)
				}
			}
			// A failed reminder write must be reported as an incomplete sync.
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(path, 0o700); err != nil {
				t.Fatal(err)
			}
			bundle = &memoryrouting.Bundle{Enabled: true, Content: "central hint"}
			if exit, err := run(); exit != 1 || err == nil || !strings.Contains(err.Error(), "managed sync incomplete") {
				t.Fatalf("failed reminder write hidden: %d %v", exit, err)
			}
		})
	}
}

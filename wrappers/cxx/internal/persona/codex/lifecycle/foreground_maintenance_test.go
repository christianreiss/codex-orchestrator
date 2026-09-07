package lifecycle

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
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// Exercise real foreground dispatch with installed CLI and deliberately stale
// wrapper/native versions. Neither a newer fleet target nor a missing peer
// may cause a download, installer, maintenance probe, or re-exec here.
func TestForegroundLaunchLeavesAllBinaryMaintenanceToBackground(t *testing.T) {
	for _, kind := range []string{"run", "resume", "execute", "sync"} {
		t.Run(kind, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
			t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
			t.Setenv("CODEX_WRAPPER_RESTARTED", "")
			bin := filepath.Join(home, "bin")
			if err := os.MkdirAll(bin, 0o700); err != nil {
				t.Fatal(err)
			}
			launchMarker, installerMarker := filepath.Join(home, "launch"), filepath.Join(home, "installer")
			t.Setenv("CDX_TEST_LAUNCH_MARKER", launchMarker)
			t.Setenv("CDX_TEST_INSTALLER_MARKER", installerMarker)
			cli := filepath.Join(bin, "codex")
			if err := os.WriteFile(cli, []byte("#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.1.0'; exit 0; fi\nprintf '%s\\n' \"$@\" > \"$CDX_TEST_LAUNCH_MARKER\"\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(bin, "npm"), []byte("#!/bin/sh\nprintf invoked > \"$CDX_TEST_INSTALLER_MARKER\"\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin)
			t.Setenv("CDX_CODEX_BIN", cli)
			payload, _ := json.Marshal(map[string]any{"last_refresh": time.Now().UTC().Format(time.RFC3339Nano), "tokens": map[string]string{"access_token": "fixture"}})
			if err := codex.WriteAuth(payload); err != nil {
				t.Fatal(err)
			}
			var maintenanceRequests atomic.Int32
			var baseURL string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/sync/bootstrap":
					_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "agents": "# fixture", "config": "model = \"gpt-6-astra\"\n", "auth": map[string]any{"status": "valid", "verification_state": "verified", "host": map[string]any{"secure": true, "engines_list": []string{"codex", "claude"}}, "versions": map[string]any{"auto_update_enabled": true, "wrapper_version": "9.9.9", "wrapper_url": baseURL + "/artifact", "wrapper_sha256": strings.Repeat("a", 64), "client_version": "9.9.9"}}})
				case "/skills":
					_, _ = io.WriteString(w, `{"skills":[]}`)
				case "/auth":
					_, _ = io.WriteString(w, `{"status":"valid","verification_state":"verified","host":{"secure":true}}`)
				default:
					if r.URL.Path == "/cron/check" || r.URL.Path == "/artifact" || strings.HasPrefix(r.URL.Path, "/wrapper/") {
						maintenanceRequests.Add(1)
						http.Error(w, "unexpected foreground maintenance", http.StatusServiceUnavailable)
						return
					}
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			baseURL = server.URL
			cfg := &config.Config{Host: config.Host{Secure: true, EnginesList: []string{"codex", "claude"}}, Orchestrator: config.Orchestrator{BaseURL: baseURL, APIKey: "fixture"}}
			opts := Options{Config: cfg, SkipBoot: true, WrapperVersion: "0.1.0", Logger: slog.New(slog.DiscardHandler)}
			switch kind {
			case "resume":
				opts.Resumed = true
				opts.ExtraArgs = []string{"resume", "fixture-session"}
			case "execute":
				opts.Headless = true
				opts.ExtraArgs = []string{"exec", "fixture prompt"}
			case "sync":
				opts.Headless = true
				opts.SyncOnly = true
			}
			exit, err := Run(context.Background(), opts)
			if exit != 0 || err != nil {
				t.Fatalf("%s launch=%d err=%v", kind, exit, err)
			}
			if maintenanceRequests.Load() != 0 {
				t.Fatalf("%s triggered %d maintenance requests", kind, maintenanceRequests.Load())
			}
			if _, err := os.Stat(installerMarker); !os.IsNotExist(err) {
				t.Fatal("foreground launch invoked npm")
			}
			_, launchErr := os.Stat(launchMarker)
			if (kind == "sync" && !os.IsNotExist(launchErr)) || (kind != "sync" && launchErr != nil) {
				t.Fatalf("native launch contract=%v", launchErr)
			}
			if kind != "sync" {
				argv, err := os.ReadFile(launchMarker)
				if err != nil || !strings.Contains(string(argv), "check_for_update_on_startup=false\n") {
					t.Fatalf("native startup update prompt not disabled: %q, %v", argv, err)
				}
			}
		})
	}
}

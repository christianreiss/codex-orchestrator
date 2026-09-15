package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
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

func TestForegroundLifecycleNeverInstallsOrReexecsAdvertisedUpdates(t *testing.T) {
	for _, mode := range []string{"run", "resume", "execute", "sync"} {
		t.Run(mode, func(t *testing.T) {
			var queued int
			previousRequest := requestBackgroundMaintenance
			requestBackgroundMaintenance = func(engine, _ string) error {
				if engine != config.EngineClaude {
					t.Fatalf("queued maintenance for wrong engine %q", engine)
				}
				queued++
				// Queue failure is debug-only and cannot prevent a launch.
				return errors.New("fixture queue unavailable")
			}
			t.Cleanup(func() { requestBackgroundMaintenance = previousRequest })
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "runtime"))
			t.Setenv("CLAUDE_WRAPPER_RESTARTED", "")
			bin := filepath.Join(home, "bin")
			if err := os.Mkdir(bin, 0o700); err != nil {
				t.Fatal(err)
			}
			nativeMarker := filepath.Join(home, "native-launched")
			installerMarker := filepath.Join(home, "installer-called")
			cli := filepath.Join(bin, "claude")
			writeTestScript(t, cli, "#!/bin/sh\ncase \"$1\" in --version|-V) echo 2.1.1;; *) echo started > \""+nativeMarker+"\";; esac\n")
			for _, tool := range []string{"npm", "sudo", "curl", "crontab"} {
				writeTestScript(t, filepath.Join(bin, tool), "#!/bin/sh\necho called > \""+installerMarker+"\"\nexit 42\n")
			}
			t.Setenv("CLX_CLAUDE_BIN", cli)
			t.Setenv("PATH", bin)
			payload := json.RawMessage(fmt.Sprintf(`{"last_refresh":%q,"claudeAiOauth":{"accessToken":"fixture","expiresAt":%d}}`, time.Now().UTC().Format(time.RFC3339Nano), time.Now().Add(time.Hour).UnixMilli()))
			if err := claude.WriteAuth(payload); err != nil {
				t.Fatal(err)
			}
			var maintenanceRequests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/sync/bootstrap":
					_, _ = fmt.Fprintf(w, `{"status":"success","data":{"agents":"# fleet remains synced","auth":{"status":"valid","verification_state":"verified","host":{"secure":true,"engines_list":["codex","claude"]},"versions":{"auto_update_enabled":true,"client_version":"9.9.9","wrapper_version":"9.9.9","wrapper_url":"http://%s/wrapper/v2/download","wrapper_sha256":%q}}}}`, r.Host, strings.Repeat("a", 64))
				case "/skills":
					_, _ = w.Write([]byte(`{"skills":[]}`))
				case "/auth":
					_, _ = w.Write([]byte(`{"status":"valid","verification_state":"verified","host":{"secure":true}}`))
				default:
					if strings.HasPrefix(r.URL.Path, "/wrapper/") || strings.HasPrefix(r.URL.Path, "/cron/") {
						maintenanceRequests.Add(1)
					}
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			cfg := &config.Config{Engine: config.EngineClaude, Host: config.Host{Secure: true, EnginesList: []string{"codex", "claude"}}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
			opts := Options{Config: cfg, SkipBoot: true, WrapperVersion: "0.8.1", Logger: slog.New(slog.DiscardHandler)}
			switch mode {
			case "resume":
				opts.Resumed = true
				opts.ExtraArgs = []string{"--resume", "fixture"}
			case "execute":
				opts.Headless = true
				opts.ExtraArgs = []string{"-p", "fixture"}
			case "sync":
				opts.SyncOnly = true
				opts.Headless = true
			}
			if exit, err := Run(context.Background(), opts); exit != 0 || err != nil {
				t.Fatalf("Run=%d %v", exit, err)
			}
			if maintenanceRequests.Load() != 0 {
				t.Fatalf("foreground maintenance HTTP calls=%d", maintenanceRequests.Load())
			}
			wantQueued := 1
			if mode == "sync" {
				wantQueued = 0
			}
			if queued != wantQueued {
				t.Fatalf("background requests=%d, want %d", queued, wantQueued)
			}
			if _, err := os.Stat(installerMarker); !os.IsNotExist(err) {
				t.Fatalf("foreground ran installer/scheduler: %v", err)
			}
			_, nativeErr := os.Stat(nativeMarker)
			if mode == "sync" && !os.IsNotExist(nativeErr) {
				t.Fatal("sync started native client")
			}
			if mode != "sync" && nativeErr != nil {
				t.Fatal("foreground did not launch existing native client")
			}
			if policy, err := os.ReadFile(filepath.Join(home, ".claude", "CLAUDE.md")); err != nil || !strings.Contains(string(policy), "fleet remains synced") {
				t.Fatal("removing upgrades lost managed content sync")
			}
		})
	}
}

func TestMissingClaudeFailsBeforeAuthAndNeverBootstrapsInstaller(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLX_CLAUDE_BIN", "/missing/claude")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
	exit, err := Run(context.Background(), Options{Config: cfg, SkipBoot: true, Logger: slog.New(slog.DiscardHandler)})
	if exit != 127 || err == nil || !strings.Contains(err.Error(), "clx --cron run") {
		t.Fatalf("missing CLI result=%d %v", exit, err)
	}
	if requests.Load() != 0 {
		t.Fatal("missing native CLI caused foreground auth/installer network work")
	}
}

func TestLoginExpiryWarningPreservesHeadlessStdoutAndExit(t *testing.T) {
	for _, remaining := range []time.Duration{48 * time.Hour, -time.Hour} {
		t.Run(remaining.String(), func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "runtime"))
			previous := requestBackgroundMaintenance
			requestBackgroundMaintenance = func(string, string) error { return nil }
			t.Cleanup(func() { requestBackgroundMaintenance = previous })
			cli := filepath.Join(home, "claude")
			writeTestScript(t, cli, "#!/bin/sh\ncase \"$1\" in --version|-V) echo 2.1.263;; *) printf '%s' '{\"result\":\"ok\"}';; esac\n")
			t.Setenv("CLX_CLAUDE_BIN", cli)
			payload := json.RawMessage(fmt.Sprintf(`{"last_refresh":%q,"claudeAiOauth":{"accessToken":"fixture","refreshToken":"fixture-refresh","expiresAt":%d,"refreshTokenExpiresAt":%d}}`, time.Now().UTC().Format(time.RFC3339Nano), time.Now().Add(time.Hour).UnixMilli(), time.Now().Add(remaining).UnixMilli()))
			if err := claude.WriteAuth(payload); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/sync/bootstrap":
					_, _ = w.Write([]byte(`{"status":"success","data":{"auth":{"status":"valid","verification_state":"verified","host":{"secure":true}}}}`))
				case "/auth":
					_, _ = w.Write([]byte(`{"status":"valid","verification_state":"verified","host":{"secure":true}}`))
				case "/skills":
					_, _ = w.Write([]byte(`{"skills":[]}`))
				default:
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			cfg := &config.Config{Engine: config.EngineClaude, Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
			output, err := os.CreateTemp(home, "stdout")
			if err != nil {
				t.Fatal(err)
			}
			defer output.Close()
			originalStdout := os.Stdout
			os.Stdout = output
			defer func() { os.Stdout = originalStdout }()
			var code int
			var runErr error
			stderr := captureStderr(t, func() {
				code, runErr = Run(context.Background(), Options{Config: cfg, SkipBoot: true, Headless: true, ExtraArgs: []string{"-p", "test", "--output-format", "json"}, Logger: slog.New(slog.DiscardHandler)})
			})
			if code != 0 || runErr != nil {
				t.Fatalf("Run=%d %v", code, runErr)
			}
			if !strings.Contains(stderr, "Run /login in Claude launched through clx.") {
				t.Fatalf("missing warning: %q", stderr)
			}
			raw, err := os.ReadFile(output.Name())
			if err != nil || string(raw) != `{"result":"ok"}` {
				t.Fatalf("stdout=%q err=%v", raw, err)
			}
		})
	}
}

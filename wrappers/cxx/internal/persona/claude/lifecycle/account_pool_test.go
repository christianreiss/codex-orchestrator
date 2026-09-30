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

func TestAccountPoolLaunchBindsSelectedCredentialsAndReleases(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	bin := filepath.Join(home, "bin")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(home, "launched")
	t.Setenv("CXX_TEST_ACCOUNT_MARKER", marker)
	cli := filepath.Join(bin, "claude")
	script := "#!/bin/sh\ncase \"$1\" in --version|-V) echo 'claude 2.1.1';; *) printf '%s' \"$CXX_PROVIDER_ACCOUNT_ID\" > \"$CXX_TEST_ACCOUNT_MARKER\";; esac\n"
	if err := os.WriteFile(cli, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", cli)
	t.Setenv("PATH", bin)
	payload := json.RawMessage(fmt.Sprintf(`{"last_refresh":%q,"claudeAiOauth":{"accessToken":"selected-access","refreshToken":"selected-refresh","expiresAt":%d}}`, time.Now().UTC().Format(time.RFC3339Nano), time.Now().Add(time.Hour).UnixMilli()))
	// Start without native credentials: the healthy pool must fill them before launch.
	var acquired, released atomic.Int32
	var wrongBinding atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/sync/bootstrap":
			_ = json.NewEncoder(w).Encode(map[string]any{"agents": "# fleet", "auth": map[string]any{"status": "missing", "account_pool": true, "host": map[string]any{"secure": true, "engines_list": []string{"claude"}}}})
		case "/auth/sessions":
			acquired.Add(1)
			var in map[string]any
			_ = json.NewDecoder(r.Body).Decode(&in)
			_ = json.NewEncoder(w).Encode(map[string]any{"account_id": 2, "account_label": "Selected", "session_id": in["session_id"], "auth": payload, "canonical_digest": strings.Repeat("b", 64), "verification_state": "verified"})
		case "/auth":
			var in map[string]any
			_ = json.NewDecoder(r.Body).Decode(&in)
			if in["account_id"] != float64(2) || in["session_id"] == nil {
				wrongBinding.Store(true)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "valid", "account_pool": true, "account_id": 2, "verification_state": "verified", "host": map[string]any{"secure": true, "engines_list": []string{"claude"}}})
		case "/auth/sessions/release":
			released.Add(1)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		case "/skills":
			_, _ = w.Write([]byte(`{"skills":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cfg := &config.Config{Engine: "claude", Host: config.Host{Secure: true, EnginesList: []string{"claude"}}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
	exit, err := Run(context.Background(), Options{Config: cfg, SkipBoot: true, Headless: true, WrapperVersion: "0.9.7", Logger: slog.New(slog.DiscardHandler)})
	if exit != 0 || err != nil {
		t.Fatalf("pool launch = %d, %v", exit, err)
	}
	raw, err := os.ReadFile(marker)
	if err != nil || string(raw) != "2" {
		t.Fatalf("selected native account = %q, %v", raw, err)
	}
	if wrongBinding.Load() || acquired.Load() != 1 || released.Load() != 1 {
		t.Fatalf("bindings: invalid=%v, acquire=%d, release=%d", wrongBinding.Load(), acquired.Load(), released.Load())
	}
	native, err := claude.ReadAuth()
	if err != nil || !strings.Contains(string(native), "selected-access") {
		t.Fatalf("native selected credential = %s, %v", native, err)
	}
}

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

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestAccountPoolLaunchBindsSelectedCredentialsAndReleases(t *testing.T) {
	for _, reuse := range []bool{false, true} {
		name := "new_account"
		if reuse {
			name = "same_verified_head"
		}
		t.Run(name, func(t *testing.T) { accountPoolLaunchFixture(t, reuse) })
	}
}

func accountPoolLaunchFixture(t *testing.T, reuse bool) {
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
	cli := filepath.Join(bin, "codex")
	script := "#!/bin/sh\ncase \"$1\" in --version|-V) echo 'codex 2.1.1';; *) printf '%s' \"$CXX_PROVIDER_ACCOUNT_ID\" > \"$CXX_TEST_ACCOUNT_MARKER\";; esac\n"
	if err := os.WriteFile(cli, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", cli)
	t.Setenv("PATH", bin)
	payload := json.RawMessage(fmt.Sprintf(`{"last_refresh":%q,"tokens":{"access_token":"selected-access","refresh_token":"selected-refresh"}}`, time.Now().UTC().Format(time.RFC3339Nano)))
	if reuse {
		path, err := codex.AuthPath()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, payload, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var acquired, released, authCalls atomic.Int32
	var wrongBinding, portalStarted atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/sync/bootstrap":
			auth := map[string]any{"status": "missing", "account_pool": true, "host": map[string]any{"secure": true, "engines_list": []string{"codex"}}}
			if reuse {
				auth["status"], auth["account_id"], auth["canonical_digest"], auth["verification_state"], auth["versions"] = "valid", 2, strings.Repeat("b", 64), "verified", map[string]any{}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"agents": "# fleet", "auth": auth})
		case "/auth/sessions":
			acquired.Add(1)
			var in map[string]any
			_ = json.NewDecoder(r.Body).Decode(&in)
			_ = json.NewEncoder(w).Encode(map[string]any{"account_id": 2, "account_label": "Selected", "session_id": in["session_id"], "auth": payload, "canonical_digest": strings.Repeat("b", 64), "verification_state": "verified"})
		case "/auth":
			var in map[string]any
			_ = json.NewDecoder(r.Body).Decode(&in)
			if in["command"] == "retrieve" && in["digest"] == strings.Repeat("b", 64) && !portalStarted.Load() {
				authCalls.Add(1)
			}
			if in["account_id"] != float64(2) || in["session_id"] == nil {
				wrongBinding.Store(true)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "valid", "account_pool": true, "account_id": 2, "verification_state": "verified", "host": map[string]any{"secure": true, "engines_list": []string{"codex"}}})
		case "/auth/sessions/release":
			released.Add(1)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		case "/host/agent-sessions":
			// Later auth-watcher pulls are independent of launch setup.
			portalStarted.Store(true)
			http.NotFound(w, r)
		case "/skills":
			_, _ = w.Write([]byte(`{"skills":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cfg := &config.Config{Engine: "codex", Host: config.Host{Secure: true, EnginesList: []string{"codex"}}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
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
	wantCalls := int32(1)
	if reuse {
		wantCalls = 0
	}
	if authCalls.Load() != wantCalls {
		t.Fatalf("post-assignment auth calls=%d, want %d", authCalls.Load(), wantCalls)
	}
	native, err := codex.ReadAuth()
	if err != nil || !strings.Contains(string(native), "selected-access") {
		t.Fatalf("native selected credential = %s, %v", native, err)
	}
}

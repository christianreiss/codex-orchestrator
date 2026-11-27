//go:build !windows

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
	"syscall"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestAccountPoolLaunchBindsSelectedCredentialsAndReleases(t *testing.T) {
	for _, scenario := range []string{"new_account", "same_verified_head", "stale_active_binding", "different_active_credentials", "native_login_during_assignment"} {
		t.Run(scenario, func(t *testing.T) { accountPoolLaunchFixture(t, scenario) })
	}
}

func accountPoolLaunchFixture(t *testing.T, scenario string) {
	active := scenario != "new_account" && scenario != "same_verified_head"
	reuse := scenario != "new_account"
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
	if reuse {
		path, err := claude.AuthPath()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		local := payload
		if scenario == "different_active_credentials" {
			local = json.RawMessage(strings.Replace(string(payload), "selected-refresh", "other-refresh", 1))
		}
		if err := os.WriteFile(path, local, 0o600); err != nil {
			t.Fatal(err)
		}
		if active {
			lock, err := os.OpenFile(filepath.Join(filepath.Dir(path), ".clx-auth-active-child.lock"), os.O_CREATE|os.O_RDWR, 0600)
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Close()
			if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_SH); err != nil {
				t.Fatal(err)
			}
			before, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				after, err := os.Stat(path)
				if err != nil || !os.SameFile(before, after) || (scenario != "native_login_during_assignment" && !after.ModTime().Equal(before.ModTime())) {
					t.Error("launch rewrote credentials under the active child")
				}
			})
		}
	}
	var acquired, released, authCalls atomic.Int32
	var wrongBinding, portalStarted atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/sync/bootstrap":
			auth := map[string]any{"status": "missing", "account_pool": true, "host": map[string]any{"secure": true, "engines_list": []string{"claude"}}}
			if reuse {
				auth["status"], auth["account_id"], auth["canonical_digest"], auth["verification_state"], auth["versions"] = "valid", 2, strings.Repeat("b", 64), "verified", map[string]any{}
			}
			if active {
				auth["account_id"] = 1
				auth["status"] = "outdated"
				auth["presented_account_id"] = 2
				auth["auth"] = json.RawMessage(strings.Replace(string(payload), "selected-access", "other-account-access", 1))
				auth["canonical_last_refresh"] = time.Now().UTC().Format(time.RFC3339Nano)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"agents": "# fleet", "auth": auth})
		case "/auth/sessions":
			acquired.Add(1)
			if scenario == "native_login_during_assignment" {
				path, _ := claude.AuthPath()
				if err := os.WriteFile(path, []byte(strings.Replace(string(payload), "selected-access", "new-login", 1)), 0600); err != nil {
					t.Error(err)
				}
			}
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
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "valid", "account_pool": true, "account_id": 2, "verification_state": "verified", "host": map[string]any{"secure": true, "engines_list": []string{"claude"}}})
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
	cfg := &config.Config{Engine: "claude", Host: config.Host{Secure: true, EnginesList: []string{"claude"}}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
	exit, err := Run(context.Background(), Options{Config: cfg, SkipBoot: true, Headless: true, WrapperVersion: "0.9.7", Logger: slog.New(slog.DiscardHandler)})
	if scenario == "different_active_credentials" || scenario == "native_login_during_assignment" {
		wantError := "would switch active local sessions"
		if scenario == "native_login_during_assignment" {
			wantError = "could not confirm the native credential generation"
		}
		if err == nil || !strings.Contains(err.Error(), wantError) || released.Load() != 1 {
			t.Fatalf("conflicting launch = %d, %v, releases = %d", exit, err, released.Load())
		}
		if _, err := os.Stat(marker); !os.IsNotExist(err) {
			t.Fatal("started a native child with conflicting credentials")
		}
		if scenario == "native_login_during_assignment" {
			local, err := claude.ReadAuth()
			if err != nil || !strings.Contains(string(local), "new-login") {
				t.Fatal("concurrent native login was lost")
			}
		}
		return
	}
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
	if reuse && !active {
		wantCalls = 0
	}
	if authCalls.Load() != wantCalls {
		t.Fatalf("post-assignment auth calls=%d, want %d", authCalls.Load(), wantCalls)
	}
	native, err := claude.ReadAuth()
	if err != nil || !strings.Contains(string(native), "selected-access") {
		t.Fatalf("native selected credential = %s, %v", native, err)
	}
}

package codexapp

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestInactiveAuthSyncSkipsConfigAndCreatesNoState(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, "absent-codex"))
	t.Setenv("CDX_AUTH_SESSION_HANDOFF", "")
	// An unset handoff, rather than an empty exported one, is normal startup.
	_ = os.Unsetenv("CDX_AUTH_SESSION_HANDOFF")
	var stdout, stderr bytes.Buffer
	code := run([]string{"auth-sync", "--config", filepath.Join(home, "missing-config.json")}, &stdout, &stderr)
	if code != 0 || stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatalf("inactive auth-sync=%d out=%q err=%q", code, stdout.String(), stderr.String())
	}
	if _, err := os.Stat(filepath.Join(home, "absent-codex")); !os.IsNotExist(err) {
		t.Fatal("inactive internal command created auth state")
	}
}

func TestAuthSyncAdapterUsesCustomCABundle(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	if err := codex.WriteAuth(json.RawMessage(`{"last_refresh":"2026-08-08T10:00:00Z","tokens":{"access_token":"old"}}`)); err != nil {
		t.Fatal(err)
	}
	child, err := codex.AcquireActiveChild()
	if err != nil {
		t.Fatal(err)
	}
	defer child.Release()
	var requests atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"valid","verification_state":"verified","host":{"secure":true}}`))
	}))
	defer server.Close()
	bundle := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(bundle, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, CABundlePath: &bundle}}
	var stdout, stderr bytes.Buffer
	if code := cmdAuthSync(context.Background(), cfg, &stdout, &stderr); code != 0 || stderr.Len() != 0 || requests.Load() != 1 {
		t.Fatalf("custom-CA auth-sync=%d requests=%d err=%q", code, requests.Load(), stderr.String())
	}
	stdout.Reset()
	stderr.Reset()
	if code := cmdAuthUpload(context.Background(), cfg, &stdout, &stderr); code != 0 || stderr.Len() != 0 || requests.Load() != 2 {
		t.Fatalf("custom-CA auth-upload=%d requests=%d err=%q", code, requests.Load(), stderr.String())
	}
}

func TestAuthSyncAdapterRequiresChildAndPreservesFinalInsecurePurge(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(map[bool]string{false: "inactive", true: "active exits during pull"}[active], func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
			old := json.RawMessage(`{"last_refresh":"2026-08-08T10:00:00Z","tokens":{"access_token":"old"}}`)
			if err := codex.WriteAuth(old); err != nil {
				t.Fatal(err)
			}
			var requests atomic.Int32
			var releaseChild = func() {}
			if active {
				child, err := codex.AcquireActiveChild()
				if err != nil {
					t.Fatal(err)
				}
				releaseChild = func() { _ = child.Release() }
				defer releaseChild()
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				releaseChild()
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "outdated", "verification_state": "verified", "host": map[string]bool{"secure": false}, "auth": json.RawMessage(`{"last_refresh":"2026-08-08T11:00:00Z","tokens":{"access_token":"new"}}`)})
			}))
			defer server.Close()
			cfg := &config.Config{Host: config.Host{Secure: false}, Orchestrator: config.Orchestrator{BaseURL: server.URL}}
			var stdout, stderr bytes.Buffer
			code := cmdAuthSync(context.Background(), cfg, &stdout, &stderr)
			if code != 0 || stderr.Len() != 0 {
				t.Fatalf("auth-sync=%d err=%q", code, stderr.String())
			}
			path, _ := codex.AuthPath()
			raw, err := os.ReadFile(path)
			if active {
				if requests.Load() != 1 || !os.IsNotExist(err) {
					t.Fatalf("active-exit purge requests=%d err=%v", requests.Load(), err)
				}
			} else if requests.Load() != 0 || string(raw) != string(old) {
				t.Fatal("inactive auth-sync touched existing credential or network")
			}
		})
	}
}

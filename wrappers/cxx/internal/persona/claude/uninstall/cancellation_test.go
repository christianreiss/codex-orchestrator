package uninstall

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestRunDistinguishesCancellationFromServerFailure(t *testing.T) {

	for _, cancelled := range []bool{true, false} {
		name := "ordinary_server_failure"
		if cancelled {
			name = "cancelled_during_delete"
		}
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
			t.Setenv("PATH", t.TempDir()) // Never probe host npm or sudo.
			nativeHome := filepath.Join(home, ".claude")

			targets := []string{filepath.Join(nativeHome, ".credentials.json"), filepath.Join(home, ".cxx", "engines", "claude", "keep")}
			for _, target := range targets {
				if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(target, []byte("retained"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			_, server := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/host/users" {
					_, _ = w.Write([]byte(`{"users":[]}`))
					return
				}
				if r.Method != http.MethodDelete || r.URL.Path != "/auth" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
				if cancelled {
					cancel()
				}
				w.WriteHeader(http.StatusBadGateway)
			})
			cfg := &config.Config{}
			cfg.Orchestrator.BaseURL = server.URL
			cfg.Orchestrator.APIKey = "test"
			err := Run(ctx, cfg, io.Discard, io.Discard)
			if cancelled && !errors.Is(err, context.Canceled) {
				t.Errorf("cancelled uninstall error = %v", err)
			}
			if !cancelled && err != nil {
				t.Errorf("ordinary server failure no longer permits local cleanup: %v", err)
			}
			for _, target := range targets {
				body, readErr := os.ReadFile(target)
				if cancelled {
					if readErr != nil || string(body) != "retained" {
						t.Errorf("cancelled uninstall changed %s: %q (%v)", target, body, readErr)
					}
				} else if !errors.Is(readErr, os.ErrNotExist) {
					t.Errorf("ordinary server failure retained %s: %v", target, readErr)
				}
			}
		})
	}
}

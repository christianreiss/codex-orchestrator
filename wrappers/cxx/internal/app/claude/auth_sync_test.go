package claudeapp

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestHiddenAuthSyncRequiresAnActiveNativeChild(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: false}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
	var stderr bytes.Buffer
	if code := cmdSessionAuthSync(context.Background(), cfg, slog.New(slog.DiscardHandler), &stderr); code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	if calls.Load() != 0 {
		t.Fatal("inactive native session caused canonical retrieval")
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("HOME"), ".clx", "auth", "purge-on-last-exit")); !os.IsNotExist(err) {
		t.Fatalf("inactive sync created purge request: %v", err)
	}
}

func TestFailedExplicitUpdateCannotPurgePendingNativeCredentials(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path, _ := claude.AuthPath()
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	native := []byte(`{"claudeAiOauth":{"accessToken":"pending-native-login"}}`)
	_ = os.WriteFile(path, native, 0o600)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: false}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
	var stdout, stderr bytes.Buffer
	if code := cmdWrapperUpdate(context.Background(), cfg, flags{minimal: true}, slog.New(slog.DiscardHandler), &stdout, &stderr); code != 1 {
		t.Fatalf("failed update exit=%d", code)
	}
	if raw, _ := os.ReadFile(path); string(raw) != string(native) {
		t.Fatal("failed update cleanup discarded pending login")
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("HOME"), ".clx", "auth", "purge-on-last-exit")); !os.IsNotExist(err) {
		t.Fatalf("failed update orphaned new purge request: %v", err)
	}
}

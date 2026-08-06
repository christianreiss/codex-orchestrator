package lifecycle

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// TestSyncOnlyRejectsSkipAuthSync pins the one combination that would otherwise
// report success without writing anything: SkipAuthSync disables the very block
// SyncOnly exists to run.
func TestSyncOnlyRejectsSkipAuthSync(t *testing.T) {
	exit, err := Run(context.Background(), Options{
		Config:       &config.Config{},
		SyncOnly:     true,
		SkipAuthSync: true,
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if exit != 2 || err == nil {
		t.Fatalf("Run(SyncOnly+SkipAuthSync) = (%d, %v), want (2, error)", exit, err)
	}
	if !strings.Contains(err.Error(), "sync-only") {
		t.Fatalf("misuse error is not self-explanatory: %v", err)
	}
}

// syncOnlyHost stands up a temp HOME plus an orchestrator that serves a healthy
// bundle. extra is folded into the auth block so a caller can make the server
// advertise a newer wrapper.
func syncOnlyHost(t *testing.T, extra string) (*config.Config, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "1")

	// A future expiresAt is what makes the OAuth credential runnable without a
	// refresh; claude.IsFresh reads it, not last_refresh (WriteAuth moves that
	// stamp into the wrapper generation file).
	expires := time.Now().Add(24 * time.Hour).UnixMilli()
	if err := claude.WriteAuth(json.RawMessage(fmt.Sprintf(
		`{"last_refresh":%q,"claudeAiOauth":{"accessToken":"live","expiresAt":%d}}`,
		time.Now().UTC().Format(time.RFC3339), expires,
	))); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sync/bootstrap" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"status":"success","agents":"# fleet claude policy\n","auth":{"status":"valid","verification_state":"verified","host":{"secure":true}` + extra + `}}}`))
	}))
	t.Cleanup(server.Close)

	return &config.Config{
		Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"},
		Host:         config.Host{Secure: true},
	}, home
}

// TestSyncOnlyWritesManagedContentAndStopsBeforeLaunch is the whole point of
// the mode: CLAUDE.md converges, and Run returns instead of exec'ing Claude.
func TestSyncOnlyWritesManagedContentAndStopsBeforeLaunch(t *testing.T) {
	cfg, home := syncOnlyHost(t, "")

	exit, err := Run(context.Background(), Options{
		Config:         cfg,
		SyncOnly:       true,
		Headless:       true,
		SkipBoot:       true,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		WrapperVersion: "0.7.0",
	})
	if exit != 0 || err != nil {
		t.Fatalf("Run(SyncOnly) = (%d, %v), want (0, nil)", exit, err)
	}

	agents, err := os.ReadFile(filepath.Join(home, ".claude", "CLAUDE.md"))
	if err != nil || !strings.Contains(string(agents), "fleet claude policy") {
		t.Fatalf("CLAUDE.md not synced: %q err=%v", agents, err)
	}
}

// TestSyncOnlyNeverSelfUpdatesOrReExecs is the invariant that keeps the restart
// depth cap intact. It matters more on this side than on codex: the `cxx update`
// re-exec sets only CODEX_WRAPPER_RESTARTED, so maybeEnsureWrapper's own loop
// guard is still cold when the claude leg runs.
func TestSyncOnlyNeverSelfUpdatesOrReExecs(t *testing.T) {
	sha := strings.Repeat("a", 64)
	cfg, _ := syncOnlyHost(t, `,"versions":{"auto_update_enabled":true,"wrapper_version":"9.9.9","wrapper_url":"https://updates.invalid/cxx","wrapper_sha256":"`+sha+`"}`)
	t.Setenv("CLAUDE_WRAPPER_RESTARTED", "")

	oldUpdate, oldExec := wrapperSelfUpdate, wrapperReExec
	t.Cleanup(func() {
		wrapperSelfUpdate = oldUpdate
		wrapperReExec = oldExec
	})
	updates, execs := 0, 0
	wrapperSelfUpdate = func(context.Context, *config.Config, string, string, string, *slog.Logger) (string, error) {
		updates++
		return "/tmp/cxx-updated", nil
	}
	wrapperReExec = func(string, []string) error {
		execs++
		return nil
	}

	exit, err := Run(context.Background(), Options{
		Config:         cfg,
		SyncOnly:       true,
		Headless:       true,
		SkipBoot:       true,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		WrapperVersion: "0.7.0",
	})
	if exit != 0 || err != nil {
		t.Fatalf("Run(SyncOnly) = (%d, %v), want (0, nil)", exit, err)
	}
	if updates != 0 || execs != 0 {
		t.Fatalf("sync-only pass self-updated: installs=%d execs=%d", updates, execs)
	}
}

// TestSyncOnlyRefusalKeepsRunParity: a host the server no longer trusts must
// fail loudly rather than report a green sync, and the trust-loss teardown that
// `run` performs still has to happen.
func TestSyncOnlyRefusalKeepsRunParity(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "1")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","auth":{"status":"disabled","reason":"host disabled by admin"}}`))
	}))
	t.Cleanup(server.Close)

	exit, err := Run(context.Background(), Options{
		Config:         &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"}},
		SyncOnly:       true,
		Headless:       true,
		SkipBoot:       true,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		WrapperVersion: "0.7.0",
	})
	if exit != 1 || err == nil {
		t.Fatalf("Run(SyncOnly) on a disabled host = (%d, %v), want (1, error)", exit, err)
	}
}

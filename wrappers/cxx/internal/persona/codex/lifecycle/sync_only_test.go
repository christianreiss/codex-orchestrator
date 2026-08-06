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
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
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

// syncOnlyHost stands up a temp CODEX_HOME plus an orchestrator that serves a
// healthy bundle. versions is folded into the auth block so a caller can make
// the server advertise a newer wrapper.
func syncOnlyHost(t *testing.T, versions string) (*config.Config, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CODEX_ALLOW_FQDN_MISMATCH", "1")

	if err := codex.WriteAuth(json.RawMessage(`{"last_refresh":"2099-01-01T00:00:00Z","tokens":{"access_token":"live"}}`)); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sync/bootstrap" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","agents":"# fleet agents\n","config":"model = \"fleet\"\n","auth":{"status":"valid","verification_state":"verified","host":{"secure":true}` + versions + `}}`))
	}))
	t.Cleanup(server.Close)

	return &config.Config{
		Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"},
	}, home
}

// TestSyncOnlyWritesManagedContentAndStopsBeforeLaunch is the whole point of
// the mode: AGENTS.md and config.toml converge, and Run returns instead of
// exec'ing Codex (there is no Codex binary on this host, so a launch attempt
// could not have produced exit 0).
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

	agents, err := os.ReadFile(filepath.Join(home, ".codex", "AGENTS.md"))
	if err != nil || !strings.Contains(string(agents), "fleet agents") {
		t.Fatalf("AGENTS.md not synced: %q err=%v", agents, err)
	}
	configToml, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil || !strings.Contains(string(configToml), `model = "fleet"`) {
		t.Fatalf("config.toml not synced: %q err=%v", configToml, err)
	}
}

// TestSyncOnlyNeverSelfUpdatesOrReExecs is the invariant that keeps the restart
// depth cap intact: the post-update pass is already the new binary, so a sync
// that self-updated would install and exec a second time from inside a sync.
func TestSyncOnlyNeverSelfUpdatesOrReExecs(t *testing.T) {
	sha := strings.Repeat("a", 64)
	cfg, _ := syncOnlyHost(t, `,"versions":{"auto_update_enabled":true,"wrapper_version":"9.9.9","wrapper_url":"https://updates.invalid/cxx","wrapper_sha256":"`+sha+`"}`)
	t.Setenv("CODEX_WRAPPER_RESTARTED", "")

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

// TestSyncOnlyStopsBeforeQuotaGate keeps quota where it belongs: it governs
// launching Codex, and a content sync consumes none of it.
func TestSyncOnlyStopsBeforeQuotaGate(t *testing.T) {
	cfg, home := syncOnlyHost(t, `,"quota_hard_fail":true,"quota_limit_percent":95,"chatgpt":{"primary_used_percent":100}`)

	exit, err := Run(context.Background(), Options{
		Config:         cfg,
		SyncOnly:       true,
		Headless:       true,
		SkipBoot:       true,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		WrapperVersion: "0.7.0",
	})
	if exit != 0 || err != nil {
		t.Fatalf("Run(SyncOnly) over quota = (%d, %v), want (0, nil)", exit, err)
	}
	if _, statErr := os.Stat(filepath.Join(home, ".codex", "AGENTS.md")); statErr != nil {
		t.Fatalf("quota gate suppressed a managed write: %v", statErr)
	}
}

// TestSyncOnlyRefusalKeepsRunParity: a host the server no longer trusts must
// fail loudly rather than report a green sync.
func TestSyncOnlyRefusalKeepsRunParity(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CODEX_ALLOW_FQDN_MISMATCH", "1")

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

var _ = orchestrator.AuthRetrieveResponse{}

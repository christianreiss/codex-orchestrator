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
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
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
		if r.URL.Path == "/skills" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"skills":[]}`)
			return
		}
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

func TestSyncOnlyFailsWhenManagedWriteFails(t *testing.T) {
	cfg, home := syncOnlyHost(t, "")
	// An unwritable managed target must be visible to cron even though local
	// credentials remain usable and an ordinary session could still launch.
	if err := os.Mkdir(filepath.Join(home, ".codex", "config.toml"), 0o700); err != nil {
		t.Fatal(err)
	}
	exit, err := Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if exit != 1 || err == nil || !strings.Contains(err.Error(), "managed sync incomplete") {
		t.Fatalf("failed config write reported sync success: exit=%d err=%v", exit, err)
	}
}

func TestSyncOnlyFailsWhenManagedWritesArePaused(t *testing.T) {
	cfg, home := syncOnlyHost(t, "")
	lock, err := ipc.Acquire("cdx")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	exit, err := Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if exit != 1 || err == nil || !strings.Contains(err.Error(), "paused") {
		t.Fatalf("paused sync reported success: exit=%d err=%v", exit, err)
	}
	if _, err := os.Stat(filepath.Join(home, ".codex", "AGENTS.md")); !os.IsNotExist(err) {
		t.Fatalf("paused sync wrote managed content: %v", err)
	}
}

func TestSyncOnlyFailsOnOfflineFallback(t *testing.T) {
	cfg, _ := syncOnlyHost(t, "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "temporarily unavailable", http.StatusBadGateway)
	}))
	defer server.Close()
	cfg.Orchestrator.BaseURL = server.URL
	cfg.Host.Secure = true
	exit, err := Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if exit != 1 || err == nil || !strings.Contains(err.Error(), "managed sync incomplete") {
		t.Fatalf("offline fallback reported sync success: exit=%d err=%v", exit, err)
	}
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

// contentOnlyHost is syncOnlyHost with the bundle request recorded, so a test
// can assert on what the wrapper actually asked for rather than only on what it
// did with the answer. `authBlock` is spliced into the response verbatim.
func contentOnlyHost(t *testing.T, authBlock string) (*config.Config, string, *[]map[string]any, *[]string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CODEX_ALLOW_FQDN_MISMATCH", "1")

	if err := codex.WriteAuth(json.RawMessage(`{"last_refresh":"2099-01-01T00:00:00Z","tokens":{"access_token":"live"}}`)); err != nil {
		t.Fatal(err)
	}

	bodies := &[]map[string]any{}
	paths := &[]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*paths = append(*paths, r.URL.Path)
		if r.URL.Path == "/skills" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"skills":[]}`)
			return
		}
		if r.URL.Path != "/sync/bootstrap" {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		if raw, err := io.ReadAll(r.Body); err == nil {
			_ = json.Unmarshal(raw, &body)
		}
		*bodies = append(*bodies, body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","agents":"# fleet agents\n","config":"model = \"fleet\"\n"` + authBlock + `}`))
	}))
	t.Cleanup(server.Close)

	return &config.Config{
		Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"},
	}, home, bodies, paths
}

func contentOnlyOptions(cfg *config.Config) Options {
	return Options{
		Config:                 cfg,
		SyncOnly:               true,
		SkipCredentialExchange: true,
		Headless:               true,
		SkipBoot:               true,
		Logger:                 slog.New(slog.NewTextHandler(io.Discard, nil)),
		WrapperVersion:         "0.8.5",
	}
}

// TestContentOnlySyncSendsNoCredentials is the contract the cron tick relies on:
// the request carries no credential material, and the local file is not touched.
func TestContentOnlySyncSendsNoCredentials(t *testing.T) {
	cfg, home, bodies, _ := contentOnlyHost(t, "")
	cfg.Host.Secure = true
	authPath, _ := codex.AuthPath()
	before, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatal(err)
	}

	exit, err := Run(context.Background(), contentOnlyOptions(cfg))
	if exit != 0 || err != nil {
		t.Fatalf("Run(content-only) = (%d, %v), want (0, nil)", exit, err)
	}
	if len(*bodies) != 1 {
		t.Fatalf("want exactly one bundle request, got %d", len(*bodies))
	}
	body := (*bodies)[0]
	if body["include_auth"] != false {
		t.Fatalf("content-only pass asked for auth: include_auth=%v", body["include_auth"])
	}
	if _, ok := body["auth_candidate"]; ok {
		t.Fatal("content-only pass offered a credential candidate")
	}
	if _, ok := body["auth_digest"]; ok {
		t.Fatal("content-only pass advertised a credential digest")
	}
	if after, rerr := os.ReadFile(authPath); rerr != nil || string(after) != string(before) {
		t.Fatalf("content-only pass rewrote auth.json: err=%v", rerr)
	}
	if agents, rerr := os.ReadFile(filepath.Join(home, ".codex", "AGENTS.md")); rerr != nil || !strings.Contains(string(agents), "fleet agents") {
		t.Fatalf("AGENTS.md not synced: %q err=%v", agents, rerr)
	}
}

// A server that returns credentials nobody asked for must not be able to push
// them onto the host through the back door of a content-only tick.
func TestContentOnlySyncIgnoresServerAuthBlock(t *testing.T) {
	cfg, _, _, _ := contentOnlyHost(t, `,"auth":{"status":"updated","verification_state":"verified","auth":{"last_refresh":"2099-06-01T00:00:00Z","tokens":{"access_token":"server-pushed"}}}`)
	cfg.Host.Secure = true
	authPath, _ := codex.AuthPath()
	before, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatal(err)
	}

	exit, err := Run(context.Background(), contentOnlyOptions(cfg))
	if exit != 0 || err != nil {
		t.Fatalf("Run(content-only) = (%d, %v), want (0, nil)", exit, err)
	}
	after, rerr := os.ReadFile(authPath)
	if rerr != nil || string(after) != string(before) {
		t.Fatalf("unsolicited auth block was written to disk: err=%v", rerr)
	}
	if strings.Contains(string(after), "server-pushed") {
		t.Fatal("content-only pass applied the server's credential")
	}
}

// An insecure host whose approval window is closed is exactly the fleet this
// mode exists for: content must converge with no credentials on the host at all.
func TestContentOnlySyncConvergesWithoutLocalCredentials(t *testing.T) {
	cfg, home, _, _ := contentOnlyHost(t, "")
	authPath, _ := codex.AuthPath()
	if err := os.Remove(authPath); err != nil {
		t.Fatal(err)
	}
	cfg.Host.Secure = false

	exit, err := Run(context.Background(), contentOnlyOptions(cfg))
	if exit != 0 || err != nil {
		t.Fatalf("Run(content-only, no credentials) = (%d, %v), want (0, nil)", exit, err)
	}
	if agents, rerr := os.ReadFile(filepath.Join(home, ".codex", "AGENTS.md")); rerr != nil || !strings.Contains(string(agents), "fleet agents") {
		t.Fatalf("AGENTS.md not synced: %q err=%v", agents, rerr)
	}
}

// A 423 is a failed content sync here, not an approval to wait for: cron must
// not block a process on a box nobody is sitting at.
func TestContentOnlySyncNeverPollsForApproval(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CODEX_ALLOW_FQDN_MISMATCH", "1")

	bundleRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sync/bootstrap" {
			bundleRequests++
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusLocked)
		_, _ = io.WriteString(w, `{"error":{"code":"insecure_pending","message":"Insecure host approval pending"}}`)
	}))
	t.Cleanup(server.Close)

	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"}}
	exit, err := Run(context.Background(), contentOnlyOptions(cfg))
	if exit != 1 || err == nil || !strings.Contains(err.Error(), "managed sync incomplete") {
		t.Fatalf("locked bundle = (%d, %v), want (1, managed sync incomplete)", exit, err)
	}
	if bundleRequests != 1 {
		t.Fatalf("content-only pass polled for approval: %d bundle requests", bundleRequests)
	}
}

// A server too old for the bundle must not be answered with a credential
// retrieve — that is the gated call this mode exists to avoid.
func TestContentOnlySyncDoesNotFallBackToLegacyRetrieve(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CODEX_ALLOW_FQDN_MISMATCH", "1")

	seen := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path)
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)

	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"}}
	exit, err := Run(context.Background(), contentOnlyOptions(cfg))
	if exit != 1 || err == nil {
		t.Fatalf("unsupported bundle = (%d, %v), want (1, error)", exit, err)
	}
	for _, path := range seen {
		if path == "/auth" {
			t.Fatal("content-only pass fell back to a credential retrieve")
		}
	}
}

// The failure path stays retryable: a broken tick must exit non-zero so cron
// tries again rather than recording a green sync it never performed.
func TestContentOnlySyncFailsRetryablyWhenBundleFails(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CODEX_ALLOW_FQDN_MISMATCH", "1")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "temporarily unavailable", http.StatusBadGateway)
	}))
	t.Cleanup(server.Close)

	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"}}
	exit, err := Run(context.Background(), contentOnlyOptions(cfg))
	if exit != 1 || err == nil || !strings.Contains(err.Error(), "managed sync incomplete") {
		t.Fatalf("failing bundle = (%d, %v), want (1, managed sync incomplete)", exit, err)
	}
}

// The axis must stay independent of SyncOnly: an explicit `cdx sync` is a human
// asking for credentials and still gets them.
func TestSyncKeepsCredentialSyncWithoutContentOnly(t *testing.T) {
	cfg, _, bodies, _ := contentOnlyHost(t, `,"auth":{"status":"valid","verification_state":"verified","host":{"secure":true}}`)

	exit, err := Run(context.Background(), Options{
		Config:         cfg,
		SyncOnly:       true,
		Headless:       true,
		SkipBoot:       true,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		WrapperVersion: "0.8.5",
	})
	if exit != 0 || err != nil {
		t.Fatalf("Run(SyncOnly) = (%d, %v), want (0, nil)", exit, err)
	}
	if len(*bodies) == 0 || (*bodies)[0]["include_auth"] != true {
		t.Fatalf("explicit sync stopped asking for credentials: %v", *bodies)
	}
}

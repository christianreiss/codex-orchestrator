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
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
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
		_, _ = w.Write([]byte(`{"status":"success","data":{"status":"success","agents":"# fleet claude policy\n","auth":{"status":"valid","verification_state":"verified","host":{"secure":true}` + extra + `}}}`))
	}))
	t.Cleanup(server.Close)

	return &config.Config{
		Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"},
		Host:         config.Host{Secure: true},
	}, home
}

func TestSyncOnlyFailsWhenManagedWriteFails(t *testing.T) {
	cfg, home := syncOnlyHost(t, "")
	if err := os.Mkdir(filepath.Join(home, ".claude", "CLAUDE.md"), 0o700); err != nil {
		t.Fatal(err)
	}
	exit, err := Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if exit != 1 || err == nil || !strings.Contains(err.Error(), "managed sync incomplete") {
		t.Fatalf("failed policy write reported sync success: exit=%d err=%v", exit, err)
	}
}

func TestSyncOnlyFailsWhenManagedWritesArePaused(t *testing.T) {
	cfg, home := syncOnlyHost(t, "")
	lock, err := ipc.Acquire("clx")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	exit, err := Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if exit != 1 || err == nil || !strings.Contains(err.Error(), "paused") {
		t.Fatalf("paused sync reported success: exit=%d err=%v", exit, err)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "CLAUDE.md")); !os.IsNotExist(err) {
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
	exit, err := Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if exit != 1 || err == nil || !strings.Contains(err.Error(), "managed sync incomplete") {
		t.Fatalf("offline fallback reported sync success: exit=%d err=%v", exit, err)
	}
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

// contentOnlyHost is syncOnlyHost with the bundle request recorded, so a test
// can assert on what the wrapper actually asked for rather than only on what it
// did with the answer. `authBlock` is spliced into the response verbatim.
func contentOnlyHost(t *testing.T, authBlock string) (*config.Config, string, *[]map[string]any, *[]string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "1")

	expires := time.Now().Add(24 * time.Hour).UnixMilli()
	if err := claude.WriteAuth(json.RawMessage(fmt.Sprintf(
		`{"last_refresh":%q,"claudeAiOauth":{"accessToken":"live","expiresAt":%d}}`,
		time.Now().UTC().Format(time.RFC3339), expires,
	))); err != nil {
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
		_, _ = w.Write([]byte(`{"status":"success","data":{"status":"success","agents":"# fleet claude policy\n"` + authBlock + `}}`))
	}))
	t.Cleanup(server.Close)

	return &config.Config{
		Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"},
		Host:         config.Host{Secure: true},
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
	authPath, _ := claude.AuthPath()
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
		t.Fatalf("content-only pass rewrote the credential file: err=%v", rerr)
	}
	if policy, rerr := os.ReadFile(filepath.Join(home, ".claude", "CLAUDE.md")); rerr != nil || !strings.Contains(string(policy), "fleet claude policy") {
		t.Fatalf("CLAUDE.md not synced: %q err=%v", policy, rerr)
	}
}

// A server that returns credentials nobody asked for must not be able to push
// them onto the host through the back door of a content-only tick.
func TestContentOnlySyncIgnoresServerAuthBlock(t *testing.T) {
	cfg, _, _, _ := contentOnlyHost(t, `,"auth":{"status":"updated","verification_state":"verified","auth":{"claudeAiOauth":{"accessToken":"server-pushed","expiresAt":4102444800000}}}`)
	authPath, _ := claude.AuthPath()
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

// The regression this mode exists to prevent: a refusal aimed at credentials
// used to strip the very managed content the tick had come to converge.
func TestContentOnlySyncKeepsManagedContentOnRefusal(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "1")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/skills" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"skills":[]}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"status":"success","agents":"# fleet claude policy\n"}}`))
	}))
	t.Cleanup(server.Close)

	settings := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settings), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(`{"model":"fleet"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"},
		Host:         config.Host{Secure: false},
	}
	exit, err := Run(context.Background(), contentOnlyOptions(cfg))
	if exit != 0 || err != nil {
		t.Fatalf("Run(content-only, no credentials) = (%d, %v), want (0, nil)", exit, err)
	}
	if _, statErr := os.Stat(settings); statErr != nil {
		t.Fatalf("content-only pass stripped managed settings: %v", statErr)
	}
	if policy, rerr := os.ReadFile(filepath.Join(home, ".claude", "CLAUDE.md")); rerr != nil || !strings.Contains(string(policy), "fleet claude policy") {
		t.Fatalf("CLAUDE.md not synced: %q err=%v", policy, rerr)
	}
}

// A 423 is a failed content sync here, not an approval to wait for: cron must
// not block a process on a box nobody is sitting at.
func TestContentOnlySyncNeverPollsForApproval(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "1")

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
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "1")

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
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "1")

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

// The axis must stay independent of SyncOnly: an explicit `clx sync` is a human
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

// TestSyncWithoutAnyCredentialsNeverLogsIn is the installer case:
// `clx sync </dev/null` on a fresh host where neither the host nor the fleet
// has Claude credentials. It must not prompt or start `claude auth login`. As
// before, the sync still refuses with the one reason naming `clx auth login`.
func TestSyncWithoutAnyCredentialsNeverLogsIn(t *testing.T) {
	for _, headless := range []bool{true, false} {
		t.Run(fmt.Sprintf("headless=%v", headless), func(t *testing.T) {
			cfg, home := syncOnlyHost(t, "")
			if err := os.RemoveAll(filepath.Join(home, ".claude")); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/skills" {
					_, _ = io.WriteString(w, `{"skills":[]}`)
					return
				}
				_, _ = io.WriteString(w, `{"status":"success","data":{"status":"success","agents":"# fleet\n","auth":{"status":"missing","host":{"secure":true}}}}`)
			}))
			defer server.Close()
			cfg.Orchestrator.BaseURL = server.URL
			marker := filepath.Join(home, "login-started")
			bin := filepath.Join(t.TempDir(), "claude")
			writeTestScript(t, bin, "#!/bin/sh\ntouch \""+marker+"\"\n")
			t.Setenv("CLX_CLAUDE_BIN", bin)
			previousTerminal := lifecycleIsTerminal
			lifecycleIsTerminal = func(int) bool { return false }
			t.Cleanup(func() { lifecycleIsTerminal = previousTerminal })
			var (
				exit int
				err  error
			)
			captureStderr(t, func() {
				exit, err = Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: headless, SkipBoot: true, Logger: slog.New(slog.DiscardHandler)})
			})
			if exit != 1 || err == nil || !strings.Contains(err.Error(), "run `clx auth login` interactively") {
				t.Fatalf("Run() = %d, %v", exit, err)
			}
			if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
				t.Fatalf("unattended sync started claude auth login: %v", statErr)
			}
		})
	}
}

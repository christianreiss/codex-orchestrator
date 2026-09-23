package cron

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
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

func TestTickPreservesUnsentInsecureCredentialsWhenAuthUploadFails(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	t.Setenv("CXX_CRON_COORDINATED", "1")
	path := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	raw := []byte(fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"pending-local","refreshToken":"pending-refresh","expiresAt":%d}}`, time.Now().Add(time.Hour).UnixMilli()))
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var stores, syncs, reports atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/cron/check":
			_, _ = w.Write([]byte(`{"action":"no_update"}`))
		case "/auth":
			var request map[string]any
			_ = json.NewDecoder(r.Body).Decode(&request)
			if request["command"] != "store" {
				t.Error("pending guard attempted canonical retrieval")
			}
			stores.Add(1)
			w.WriteHeader(http.StatusServiceUnavailable)
		case "/sync/bootstrap":
			syncs.Add(1)
			w.WriteHeader(http.StatusServiceUnavailable)
		case "/cron/report":
			reports.Add(1)
			_, _ = w.Write([]byte(`{"recorded":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cfg := minimalCfg(server.URL)
	cfg.Host.Secure = false
	res, err := Tick(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "preserve pending native credentials") || res.SyncAction != "failed" {
		t.Fatalf("failed pending auth guard result=%+v err=%v", res, err)
	}
	if stores.Load() != 6 || syncs.Load() != 0 || reports.Load() != 1 || !res.Reported {
		t.Fatalf("maintenance calls stores=%d syncs=%d reports=%d result=%+v", stores.Load(), syncs.Load(), reports.Load(), res)
	}
	// A later nonpurging session proves the failed tick left no new sticky
	// cleanup request, in addition to preserving the spendable native file.
	probe, err := claude.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	if purged, err := probe.CloseAndPurgeIfLast(); err != nil || purged {
		t.Fatalf("failed maintenance created purge request: purged=%t err=%v", purged, err)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != string(raw) {
		t.Fatalf("failed maintenance lost pending native credentials: exists=%t unchanged=%t", err == nil, string(got) == string(raw))
	}
}

// clx and cdx share the crc32(hostname) derivation; the offset is the only
// thing keeping a dual-engine host from running both ticks in the same minute.
func TestEnsureCronPathPrependsLocalBin(t *testing.T) {
	t.Setenv("PATH", "/usr/bin:/bin")
	ensureCronPath()
	got := strings.Split(os.Getenv("PATH"), ":")
	want := []string{"/usr/local/sbin", "/usr/local/bin", "/usr/bin", "/bin"}
	if strings.Join(got, ":") != strings.Join(want, ":") {
		t.Fatalf("PATH = %q, want %q", strings.Join(got, ":"), strings.Join(want, ":"))
	}
}

func TestResolveURL(t *testing.T) {
	got := resolveURL("https://orc/", "/wrapper/v2/download")
	if got != "https://orc/wrapper/v2/download" {
		t.Errorf("got %s", got)
	}
}

func minimalCfg(baseURL string) *config.Config {
	return &config.Config{
		SchemaVersion: config.SchemaVersion,
		Engine:        config.EngineClaude,
		Orchestrator: config.Orchestrator{
			BaseURL: baseURL,
			APIKey:  "sk-clx-test-12345",
		},
		Host: config.Host{ID: 1, FQDN: "h.test"},
		Wrapper: config.Wrapper{
			Version:      "dev",
			BinaryURL:    "https://example.invalid/x",
			BinarySHA256: strings.Repeat("a", 64),
		},
	}
}

func TestTickNoUpdateReportsAndReturns(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	t.Setenv("PATH", "")

	var checkCalls, reportCalls int32
	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&checkCalls, 1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "no_update",
			"wrapper": map[string]any{
				"action": "no_update",
			},
		})
	})
	mux.HandleFunc("/cron/report", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reportCalls, 1)
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		body := string(buf[:n])
		if !strings.Contains(body, `"engine":"claude"`) {
			t.Errorf("report missing engine: %s", body)
		}
		_, _ = w.Write([]byte(`{"recorded":true}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	cfg := minimalCfg(srv.URL)
	stubManagedSync(t)
	res, err := Tick(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if !res.Reported {
		t.Errorf("expected Reported=true; got %+v", res)
	}
	if checkCalls != 1 || reportCalls != 1 {
		t.Errorf("calls: check=%d report=%d", checkCalls, reportCalls)
	}
}

func TestTickDisablePreservesManagedSyncAndReporting(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	t.Setenv("PATH", "")
	var reportCalls atomic.Int32

	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "disable",
			"wrapper": map[string]any{
				"action": "update", // Outer disabled policy wins over nested metadata.
			},
		})
	})
	mux.HandleFunc("/cron/report", func(w http.ResponseWriter, r *http.Request) {
		reportCalls.Add(1)
		_, _ = w.Write([]byte(`{"recorded":true}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	var syncCalls int
	oldSync := syncManagedContent
	syncManagedContent = func(context.Context, *config.Config, bool) error { syncCalls++; return nil }
	t.Cleanup(func() { syncManagedContent = oldSync })
	res, err := Tick(context.Background(), minimalCfg(srv.URL))
	if err != nil {
		t.Fatalf("Tick disable: %v", err)
	}
	if res.WrapperAction != "disable" || res.CodexAction != "disable" {
		t.Errorf("expected disabled actions; got %+v", res)
	}
	if syncCalls != 1 || reportCalls.Load() != 1 || !res.Reported {
		t.Fatalf("disabled binary updates lost scheduled upkeep: sync=%d reports=%d result=%+v", syncCalls, reportCalls.Load(), res)
	}
}

func TestTickHonorsConfiguredCAForCheckAndReport(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	t.Setenv("CXX_CRON_COORDINATED", "1")
	stubManagedSync(t)
	var checks, reports atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/cron/check":
			checks.Add(1)
			_, _ = w.Write([]byte(`{"action":"no_update"}`))
		case "/cron/report":
			reports.Add(1)
			_, _ = w.Write([]byte(`{"recorded":true}`))
		default:
			t.Errorf("unexpected maintenance request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	bundle := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(bundle, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := minimalCfg(server.URL)
	cfg.Orchestrator.CABundlePath = &bundle
	res, err := Tick(context.Background(), cfg)
	if err != nil || !res.Reported || checks.Load() != 1 || reports.Load() != 1 {
		t.Fatalf("custom-CA maintenance=%+v checks=%d reports=%d err=%v", res, checks.Load(), reports.Load(), err)
	}
}

func TestTickRejectsNativeUpdateWithoutTarget(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	stubManagedSync(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cron/check" {
			t.Errorf("malformed update continued to %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"action":"update"}`))
	}))
	defer server.Close()
	res, err := Tick(context.Background(), minimalCfg(server.URL))
	if err == nil || !strings.Contains(err.Error(), "without a target version") || res.CodexAction == "updated" {
		t.Fatalf("missing target result=%+v err=%v", res, err)
	}
}

func TestTickReportsOperatorCLIOverrideWithoutInstalling(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	t.Setenv("CXX_CRON_COORDINATED", "1")
	stubManagedSync(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/cron/check":
			_, _ = w.Write([]byte(`{"action":"update","target_version":"2.1.2"}`))
		case "/cron/report":
			_, _ = w.Write([]byte(`{"recorded":true}`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	res, err := Tick(context.Background(), minimalCfg(server.URL))
	if err != nil || res.CodexAction != "skipped_override" || !res.Reported {
		t.Fatalf("CLI override result=%+v err=%v", res, err)
	}
}

func TestTickWrapperUpdateLoopGuard(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLAUDE_WRAPPER_RESTARTED", "1")
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	t.Setenv("PATH", "")

	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "no_update",
			"wrapper": map[string]any{
				"action":         "update",
				"target_version": "9.9.9",
				"sha256":         strings.Repeat("a", 64),
				"url":            "/wrapper/v2/download/clx",
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	cfg := minimalCfg(srv.URL)
	stubManagedSync(t)
	_, err := Tick(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected loop-detected error")
	}
	if !strings.Contains(err.Error(), "wrapper update loop detected") {
		t.Errorf("unexpected err: %v", err)
	}
}

// stubManagedSync keeps a tick's content-sync step out of the test process:
// lifecycle.Run would take the host's real clx lock and talk to an orchestrator
// these tests do not stand up. Tests that care about the step swap it themselves.
func stubManagedSync(t *testing.T) {
	t.Helper()
	previous := syncManagedContent
	syncManagedContent = func(context.Context, *config.Config, bool) error { return nil }
	t.Cleanup(func() { syncManagedContent = previous })
}

// TestTickSyncsManagedContentAfterEngineUpdate pins the reason this exists: an
// idle host that never launches an engine still has to converge on fleet config.
func TestTickSyncsManagedContentAfterEngineUpdate(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	t.Setenv("PATH", "")
	previous := syncManagedContent
	calls := 0
	syncManagedContent = func(context.Context, *config.Config, bool) error {
		calls++
		return nil
	}
	t.Cleanup(func() { syncManagedContent = previous })

	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action":  "no_update",
			"wrapper": map[string]any{"action": "no_update"},
		})
	})
	mux.HandleFunc("/cron/report", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"recorded":true}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	res, err := Tick(context.Background(), minimalCfg(srv.URL))
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if calls != 1 {
		t.Fatalf("managed content sync ran %d times, want 1", calls)
	}
	if res.SyncAction != "" {
		t.Fatalf("healthy sync reported %q", res.SyncAction)
	}
}

// An auth-refused host must still report observed versions, and the tick must
// return failure so the coordinator retries the pending managed content.
func TestTickReportsFailedContentSync(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	t.Setenv("PATH", "")
	previous := syncManagedContent
	syncManagedContent = func(context.Context, *config.Config, bool) error {
		return errors.New("launch refused: host disabled")
	}
	t.Cleanup(func() { syncManagedContent = previous })

	var reported int32
	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action":  "no_update",
			"wrapper": map[string]any{"action": "no_update"},
		})
	})
	mux.HandleFunc("/cron/report", func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&reported, 1)
		_, _ = w.Write([]byte(`{"recorded":true}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	res, err := Tick(context.Background(), minimalCfg(srv.URL))
	if err == nil || !strings.Contains(err.Error(), "host disabled") {
		t.Fatalf("failed content sync was hidden: %v", err)
	}
	if res.SyncAction != "failed" {
		t.Fatalf("SyncAction = %q, want failed", res.SyncAction)
	}
	if !res.Reported || atomic.LoadInt32(&reported) != 1 {
		t.Fatalf("tick stopped reporting after a sync failure: %+v", res)
	}
}

// TestTickSkipsSyncWhenWrapperUpdatePathTaken: the wrapper-update branch execs
// or fails; either way this tick must not sync with the code it just replaced.
func TestTickSkipsSyncWhenWrapperUpdatePathTaken(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLAUDE_WRAPPER_RESTARTED", "1")
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	t.Setenv("PATH", "")
	previous := syncManagedContent
	calls := 0
	syncManagedContent = func(context.Context, *config.Config, bool) error {
		calls++
		return nil
	}
	t.Cleanup(func() { syncManagedContent = previous })

	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "no_update",
			"wrapper": map[string]any{
				"action":         "update",
				"target_version": "9.9.9",
				"url":            "/wrapper/v2/download",
				"sha256":         strings.Repeat("a", 64),
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	if _, err := Tick(context.Background(), minimalCfg(srv.URL)); err == nil {
		t.Fatal("expected the restart-loop guard to fail the tick")
	}
	if calls != 0 {
		t.Fatalf("synced %d times on the wrapper-update path", calls)
	}
}

// TestSyncManagedContentNeverRequestsCredentials pins the cron→lifecycle wiring
// itself, which every other test in this file stubs away: an unattended tick
// must ask for content and nothing else, so it can never open an insecure
// approval nobody is there to answer.
func TestSyncManagedContentNeverRequestsCredentials(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "1")

	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/skills" {
			_, _ = w.Write([]byte(`{"skills":[]}`))
			return
		}
		if r.URL.Path != "/sync/bootstrap" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"status":"success","data":{"status":"success","agents":"# fleet claude policy\n"}}`))
	}))
	defer server.Close()

	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"}}
	if err := syncManagedContent(context.Background(), cfg, true); err != nil {
		t.Fatalf("cron managed sync failed: %v", err)
	}
	if body == nil {
		t.Fatal("cron tick never reached /sync/bootstrap")
	}
	if body["include_auth"] != false {
		t.Fatalf("cron tick asked for credentials: include_auth=%v", body["include_auth"])
	}
	if _, ok := body["auth_candidate"]; ok {
		t.Fatal("cron tick offered a credential candidate")
	}
}

// TestEnsureEngineCurrentRespectsDisable exercises the path `clx sync` takes
// after a `clx update` re-exec: when the server has binary updates disabled,
// EnsureEngineCurrent must not attempt an install and must not report.
func TestEnsureEngineCurrentRespectsDisable(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	var reportCalls, probeSeen int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/cron/check":
			buf := make([]byte, 4096)
			n, _ := r.Body.Read(buf)
			if strings.Contains(string(buf[:n]), `"probe":true`) {
				atomic.AddInt32(&probeSeen, 1)
			}
			_, _ = w.Write([]byte(`{"action":"disable","wrapper":{"action":"no_update"}}`))
		case "/cron/report":
			atomic.AddInt32(&reportCalls, 1)
			_, _ = w.Write([]byte(`{"recorded":true}`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	res, err := EnsureEngineCurrent(context.Background(), minimalCfg(server.URL), nil)
	if err != nil || res.CodexAction != "disable" {
		t.Fatalf("EnsureEngineCurrent disable: result=%+v err=%v", res, err)
	}
	if reportCalls != 0 {
		t.Fatalf("expected no /cron/report while disabled; got %d", reportCalls)
	}
	if probeSeen != 1 {
		t.Fatal("EnsureEngineCurrent must mark itself as a probe, not a cron tick")
	}
}

// TestEnsureEngineCurrentNoUpdate covers the common case: server says the
// installed version is already current, so EnsureEngineCurrent is a no-op.
func TestEnsureEngineCurrentNoUpdate(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/cron/check" {
			t.Errorf("unexpected request %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"action":"no_update","wrapper":{"action":"no_update"}}`))
	}))
	defer server.Close()

	res, err := EnsureEngineCurrent(context.Background(), minimalCfg(server.URL), nil)
	if err != nil || res.CodexAction != "no_update" || res.Reported {
		t.Fatalf("EnsureEngineCurrent no_update: result=%+v err=%v", res, err)
	}
}

// TestEnsureEngineCurrentReportsOperatorCLIOverrideWithoutInstalling mirrors
// TestTickReportsOperatorCLIOverrideWithoutInstalling for the standalone path
// `clx sync` calls after a wrapper self-update.
func TestEnsureEngineCurrentReportsOperatorCLIOverrideWithoutInstalling(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/cron/check":
			_, _ = w.Write([]byte(`{"action":"update","target_version":"2.1.2"}`))
		case "/cron/report":
			_, _ = w.Write([]byte(`{"recorded":true}`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	res, err := EnsureEngineCurrent(context.Background(), minimalCfg(server.URL), nil)
	if err != nil || res.CodexAction != "skipped_override" || res.Reported {
		t.Fatalf("EnsureEngineCurrent override: result=%+v err=%v", res, err)
	}
}

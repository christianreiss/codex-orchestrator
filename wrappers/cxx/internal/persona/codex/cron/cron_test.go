package cron

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

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
	cases := []struct {
		base, in, want string
	}{
		{"https://orc.example", "https://other/x", "https://other/x"},
		{"https://orc.example", "/wrapper/v2/download", "https://orc.example/wrapper/v2/download"},
		{"https://orc.example/", "/wrapper/v2/download", "https://orc.example/wrapper/v2/download"},
		{"https://orc.example", "wrapper/v2/download", "https://orc.example/wrapper/v2/download"},
	}
	for _, tc := range cases {
		got := resolveURL(tc.base, tc.in)
		if got != tc.want {
			t.Errorf("resolveURL(%q,%q)=%q want %q", tc.base, tc.in, got, tc.want)
		}
	}
}

// minimalCfg is a hand-crafted config struct that bypasses the loader and
// signature verification — it's only used to drive Tick against an httptest
// server.
func minimalCfg(baseURL string) *config.Config {
	return &config.Config{
		SchemaVersion: config.SchemaVersion,
		Engine:        config.EngineCodex,
		Orchestrator: config.Orchestrator{
			BaseURL: baseURL,
			APIKey:  "sk-cdx-test-12345",
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
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist") // codex.Version() returns "unknown"
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
		body, _ := readAll(r)
		if !strings.Contains(body, `"engine":"codex"`) {
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

func TestTickDisableRemovesCron(t *testing.T) {
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")
	t.Setenv("PATH", "")
	previousRemoveSchedule := removeSchedule
	removeCalls := 0
	removeSchedule = func() error {
		removeCalls++
		return nil
	}
	t.Cleanup(func() { removeSchedule = previousRemoveSchedule })

	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "disable",
			"wrapper": map[string]any{
				"action": "no_update",
			},
		})
	})
	mux.HandleFunc("/cron/report", func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("report should not be called when disabled")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	cfg := minimalCfg(srv.URL)
	stubManagedSync(t)
	res, err := Tick(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Tick disable: %v", err)
	}
	if res.WrapperAction != "disable" || res.CodexAction != "disable" {
		t.Errorf("expected disabled actions; got %+v", res)
	}
	if removeCalls != 1 {
		t.Errorf("remove calls = %d, want 1", removeCalls)
	}
}

func TestTickWrapperUpdateLoopGuard(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTARTED", "1")
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")
	t.Setenv("PATH", "")

	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "no_update",
			"wrapper": map[string]any{
				"action":         "update",
				"target_version": "9.9.9",
				"sha256":         strings.Repeat("a", 64),
				"url":            "/wrapper/v2/download/cdx",
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

func TestTickWrapperUpdateRefusesIncompleteMetadata(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTARTED", "")
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")
	t.Setenv("PATH", "")

	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "no_update",
			"wrapper": map[string]any{
				"action":         "update",
				"target_version": "9.9.9",
				// missing sha256/url on purpose
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	cfg := minimalCfg(srv.URL)
	stubManagedSync(t)
	_, err := Tick(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected metadata-incomplete error")
	}
	if !strings.Contains(err.Error(), "metadata incomplete") {
		t.Errorf("unexpected err: %v", err)
	}
}

func TestTickReportRetriesThenFails(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTARTED", "")
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")
	t.Setenv("PATH", "")

	var reportCalls int32
	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "no_update",
			"wrapper": map[string]any{
				"action": "no_update",
			},
		})
	})
	mux.HandleFunc("/cron/report", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reportCalls, 1)
		w.WriteHeader(500)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	cfg := minimalCfg(srv.URL)
	// Shorten time.After by using a cancellable context that completes after
	// the second attempt. The 2s retry sleep will be cut short by ctx.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		// Wait long enough for at least one /cron/check + first /cron/report.
		// Then cancel during the 2s backoff before the second report attempt.
		for atomic.LoadInt32(&reportCalls) < 1 {
		}
		cancel()
	}()
	stubManagedSync(t)
	_, err := Tick(ctx, cfg)
	if err == nil {
		t.Fatal("expected report failure error")
	}
}

func readAll(r *http.Request) (string, error) {
	b := make([]byte, 4096)
	n, _ := r.Body.Read(b)
	return string(b[:n]), nil
}

// stubManagedSync keeps a tick's content-sync step out of the test process:
// lifecycle.Run would take the host's real cdx lock and talk to an orchestrator
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
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")
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

// TestTickSurvivesFailedContentSync: an auth-refused host must not turn the
// whole maintenance tick red, but the failure has to stay visible.
func TestTickSurvivesFailedContentSync(t *testing.T) {
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")
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
	if err != nil {
		t.Fatalf("failed content sync turned the tick red: %v", err)
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
	t.Setenv("CODEX_WRAPPER_RESTARTED", "1")
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")
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

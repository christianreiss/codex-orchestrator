package cron

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

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
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
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
		t.Fatal("report should not be called when disabled")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	res, err := Tick(context.Background(), minimalCfg(srv.URL))
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
	_, err := Tick(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected loop-detected error")
	}
	if !strings.Contains(err.Error(), "wrapper update loop detected") {
		t.Errorf("unexpected err: %v", err)
	}
}

package grok

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func TestMaintenanceOfferedWrapperUpdateUsesConfiguredLogger(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cli := filepath.Join(t.TempDir(), "grok")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf 'grok 1.0.46\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CGX_GROK_BIN", cli)
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	var checks, downloads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cron/check":
			checks.Add(1)
			var request orchestrator.CronCheckRequest
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			if request.Engine != "grok" || request.ClientVersion != "1.0.46" || request.WrapperVersion != Version {
				t.Errorf("wrong Grok update check: %+v", request)
			}
			_ = json.NewEncoder(w).Encode(orchestrator.CronCheckResponse{
				Action: "no_update",
				Wrapper: &orchestrator.CronWrapperBlock{
					Action: "update", TargetVersion: "0.9.13", SHA256: strings.Repeat("a", 64),
					URL: "http://" + r.Host + "/offered-cxx",
				},
			})
		case "/offered-cxx":
			downloads.Add(1)
			if r.Header.Get("X-API-Key") != "fixture-host-key" || r.Header.Get("User-Agent") != "cxx-update/0.9.13" {
				t.Error("offered wrapper download lost host authentication or version")
			}
			// Stop before filesystem installation/re-exec while exercising the
			// real updater's logging and authenticated download path.
			http.Error(w, "fixture artifact unavailable", http.StatusServiceUnavailable)
		default:
			t.Errorf("unexpected maintenance request: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	cfg := &config.Config{Engine: config.EngineGrok}
	cfg.Orchestrator.BaseURL, cfg.Orchestrator.APIKey = server.URL, "fixture-host-key"
	client := &orchestrator.Client{BaseURL: server.URL, APIKey: cfg.Orchestrator.APIKey, HTTP: server.Client(), Logger: logger}
	err := maintenance(context.Background(), cfg, client, true, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "download binary: HTTP 503") {
		t.Fatalf("offered update did not return its download failure: %v", err)
	}
	if checks.Load() != 1 || downloads.Load() != 1 || !strings.Contains(logs.String(), "cxx update starting") {
		t.Fatalf("offered updater path not exercised: checks=%d downloads=%d logs=%q", checks.Load(), downloads.Load(), logs.String())
	}
}

func TestMaintenanceHonorsExplicitSyncOverrideAndCLIOverride(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GROK_HOME", filepath.Join(t.TempDir(), "grok"))
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv("CXX_CRON_COORDINATED", "1")
	cli := filepath.Join(t.TempDir(), "grok")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\necho 'grok 1.0.46'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CGX_GROK_BIN", cli)
	var bootstrap atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/cron/check":
			_, _ = w.Write([]byte(`{"action":"update","target_version":"99.0.0"}`))
		case "/sync/bootstrap":
			bootstrap.Add(1)
			_, _ = w.Write([]byte(`{"status":"ok","grok_skills":[]}`))
		case "/host/users", "/cron/report":
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		default:
			t.Errorf("unexpected network request: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	cfg := &config.Config{Engine: "grok"}
	cfg.Host.EnginesList = []string{"grok"}
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	lock, err := ipc.TryAcquireExclusive("cgx-sync")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if err := maintenance(context.Background(), cfg, client, true, io.Discard, io.Discard); err == nil || !strings.Contains(err.Error(), "active session") {
		t.Fatalf("lock bypassed: %v", err)
	}
	if bootstrap.Load() != 0 {
		t.Fatal("locked maintenance wrote content")
	}
	if err := maintenance(context.Background(), cfg, client, true, io.Discard, io.Discard, true); err != nil {
		t.Fatal(err)
	}
	if bootstrap.Load() != 1 {
		t.Fatal("override failed to sync")
	}
	raw, _ := os.ReadFile(cli)
	if !strings.Contains(string(raw), "1.0.46") {
		t.Fatal("explicit native override replaced")
	}
}

func TestMaintenanceDisabledDoesNotInstallMissingCLI(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GROK_HOME", t.TempDir())
	t.Setenv("CGX_GROK_BIN", filepath.Join(t.TempDir(), "absent"))
	t.Setenv("PATH", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cron/check" {
			t.Errorf("unexpected request %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"action":"disable"}`))
	}))
	defer server.Close()
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	err := maintenance(context.Background(), &config.Config{Engine: "grok"}, client, false, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "no installation authorized") {
		t.Fatalf("missing disabled CLI not refused: %v", err)
	}
}

func TestMaintenanceAliasesKeepConcurrentSyncFlag(t *testing.T) {
	for _, args := range [][]string{{"update", "--allow-concurrent-sync"}, {"--update", "--allow-concurrent-sync"}, {"--cron", "run", "--allow-concurrent-sync"}, {"sync", "--allow-concurrent-sync"}} {
		o, err := parse(args)
		if err != nil || !o.concurrent {
			t.Fatalf("lost flag %v: %+v %v", args, o, err)
		}
	}
}

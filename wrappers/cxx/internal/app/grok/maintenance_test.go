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

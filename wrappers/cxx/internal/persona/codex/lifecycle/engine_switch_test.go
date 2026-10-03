package lifecycle

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

const codexFleetDisabled = "Codex is disabled fleet-wide by the administrator."

// engineSwitchHost is a host with fresh cached credentials — exactly what the
// offline fallback would launch from — talking to handler (nil: unreachable).
func engineSwitchHost(t *testing.T, handler http.HandlerFunc, suspended ...string) *config.Config {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CODEX_ALLOW_FQDN_MISMATCH", "1")
	if err := codex.WriteAuth(json.RawMessage(`{"last_refresh":"2099-01-01T00:00:00Z","tokens":{"access_token":"live"}}`)); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	if handler == nil {
		server.Close() // nothing listens: every request is a transport failure
	} else {
		t.Cleanup(server.Close)
	}
	return &config.Config{
		Engine:       config.EngineCodex,
		Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"},
		Host:         config.Host{Secure: true, EnginesList: []string{config.EngineCodex}, FleetDisabledEngines: suspended},
	}
}

func runSyncOnly(t *testing.T, cfg *config.Config) (int, error) {
	t.Helper()
	return Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
}

func TestFleetSwitchRefusesLaunchEvenWithFreshCachedAuth(t *testing.T) {
	cfg := engineSwitchHost(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"status":"error","message":"Codex is disabled fleet-wide by the administrator","code":"engine_disabled","scope":"fleet","engine":"codex"}`))
	})
	exit, err := runSyncOnly(t, cfg)
	if exit == 0 || err == nil || !strings.Contains(err.Error(), codexFleetDisabled) {
		t.Fatalf("fleet switch did not refuse with its message: exit=%d err=%v", exit, err)
	}
}

// Offline must not bypass the switch: a signed config that says suspended
// refuses even though the cached credentials would otherwise launch.
func TestLocallySuspendedConfigRefusesWhileOffline(t *testing.T) {
	exit, err := runSyncOnly(t, engineSwitchHost(t, nil, config.EngineCodex))
	if exit == 0 || err == nil || !strings.Contains(err.Error(), codexFleetDisabled) {
		t.Fatalf("offline launch bypassed the local suspension: exit=%d err=%v", exit, err)
	}
	// Control: the same outage without the suspension keeps today's behavior
	// (cached auth allows the launch; a sync-only pass reports it incomplete).
	_, err = runSyncOnly(t, engineSwitchHost(t, nil))
	if err == nil || strings.Contains(err.Error(), "disabled") {
		t.Fatalf("unsuspended outage changed behavior: %v", err)
	}
}

func TestApplyLocalSuspensionOnlyOverridesUnansweredDecisions(t *testing.T) {
	suspended := &config.Config{Host: config.Host{FleetDisabledEngines: []string{config.EngineCodex}}}
	for _, status := range []string{"offline", "error", ""} {
		dec := applyLocalSuspension(suspended, orchestrator.AuthDecision{Allowed: true, LocalUsable: true, Status: status})
		if dec.Allowed || dec.LocalUsable || dec.Status != orchestrator.AuthStatusSuspended || dec.Reason != codexFleetDisabled {
			t.Fatalf("%q: suspension bypassed: %+v", status, dec)
		}
	}
	answered := orchestrator.AuthDecision{Allowed: true, Status: "valid"}
	if got := applyLocalSuspension(suspended, answered); got != answered {
		t.Fatalf("a positive server answer (switch back on) was overridden: %+v", got)
	}
	if got := applyLocalSuspension(&config.Config{}, orchestrator.AuthDecision{Allowed: true, Status: "offline"}); !got.Allowed {
		t.Fatal("unsuspended offline fallback was refused")
	}
}

// Re-enable lands on the next launch: a stale suspended config plus a
// positive /auth answer requests the coordinator now, past its cooldown.
func TestReenabledEngineRequestsImmediateMaintenance(t *testing.T) {
	var calls []string
	prev := requestMaintenanceNow
	requestMaintenanceNow = func(engine, _ string) error { calls = append(calls, engine); return nil }
	t.Cleanup(func() { requestMaintenanceNow = prev })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	assigned := []string{config.EngineCodex, config.EngineClaude}
	suspended := &config.Config{Host: config.Host{EnginesList: assigned, FleetDisabledEngines: []string{config.EngineCodex}}}

	if reconcileEngineDrift(suspended, &orchestrator.AuthRetrieveResponse{Status: "offline"}, logger) || len(calls) != 0 {
		t.Fatalf("an unanswered launch claimed the switch is back on: %v", calls)
	}
	if !reconcileEngineDrift(suspended, &orchestrator.AuthRetrieveResponse{Status: "valid"}, logger) || len(calls) != 1 || calls[0] != config.EngineCodex {
		t.Fatalf("re-enabled engine did not refresh its config now: %v", calls)
	}
	if !reconcileEngineDrift(suspended, &orchestrator.AuthRetrieveResponse{Status: "missing"}, logger) || len(calls) != 2 {
		t.Fatalf("missing/upload_required is a positive answer too: %v", calls)
	}

	calls = nil
	enabled := &config.Config{Host: config.Host{EnginesList: assigned}}
	same := &orchestrator.AuthRetrieveResponse{Status: "valid", Host: &orchestrator.HostInfo{EnginesList: assigned, FleetDisabledEngines: []string{}}}
	if reconcileEngineDrift(enabled, same, logger) || len(calls) != 0 {
		t.Fatalf("unchanged switch state requested maintenance: %v", calls)
	}
	legacy := &orchestrator.AuthRetrieveResponse{Status: "valid", Host: &orchestrator.HostInfo{EnginesList: assigned}}
	if reconcileEngineDrift(enabled, legacy, logger) || len(calls) != 0 {
		t.Fatalf("a server that does not report the switch requested maintenance: %v", calls)
	}
	sibling := &orchestrator.AuthRetrieveResponse{Status: "valid", Host: &orchestrator.HostInfo{EnginesList: assigned, FleetDisabledEngines: []string{config.EngineClaude}}}
	if !reconcileEngineDrift(enabled, sibling, logger) || len(calls) != 1 {
		t.Fatalf("a sibling switched off fleet-wide did not refresh configs: %v", calls)
	}
}

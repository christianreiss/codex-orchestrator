package lifecycle

import (
	"io"
	"log/slog"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func TestReconcileEngineDriftForcesMaintenanceOnlyOnChange(t *testing.T) {
	var calls []string
	prev := requestMaintenanceNow
	requestMaintenanceNow = func(engine, _ string) error { calls = append(calls, engine); return nil }
	t.Cleanup(func() { requestMaintenanceNow = prev })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := &config.Config{Host: config.Host{EnginesList: []string{config.EngineCodex}}}

	same := &orchestrator.AuthRetrieveResponse{Host: &orchestrator.HostInfo{EnginesList: []string{config.EngineCodex}}}
	if reconcileEngineDrift(cfg, same, logger) || len(calls) != 0 {
		t.Fatalf("unchanged engine set requested maintenance: %v", calls)
	}
	if reconcileEngineDrift(cfg, &orchestrator.AuthRetrieveResponse{}, logger) || len(calls) != 0 {
		t.Fatalf("missing host block requested maintenance: %v", calls)
	}
	both := &orchestrator.AuthRetrieveResponse{Host: &orchestrator.HostInfo{Engines: "codex,claude"}}
	if !reconcileEngineDrift(cfg, both, logger) || len(calls) != 1 || calls[0] != config.EngineCodex {
		t.Fatalf("enabled peer engine did not force maintenance: %v", calls)
	}
}

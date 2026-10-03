package lifecycle

import (
	"log/slog"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/maintenance"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

var requestMaintenanceNow = maintenance.RequestNow

// reconcileEngineDrift forces background maintenance past its cooldown when
// the server's view of this host's engines differs from the locally baked
// one, so an operator's change lands on this launch rather than after the next
// scheduled tick. Three changes count: the host engine assignment (provision
// or remove a peer), the fleet suspension list, and — the re-enable path —
// a signed config that still says this engine is suspended while the server
// just answered for it. The coordinator rewrites the local config, which
// clears the drift.
func reconcileEngineDrift(cfg *config.Config, auth *orchestrator.AuthRetrieveResponse, logger *slog.Logger) bool {
	if cfg == nil || auth == nil {
		return false
	}
	reason := engineDriftReason(cfg, auth)
	if reason == "" {
		return false
	}
	if err := requestMaintenanceNow(config.EngineClaude, cfg.SourcePath()); err != nil {
		logger.Debug("engine-change maintenance request deferred", "err", err)
		return false
	}
	logger.Info(reason + "; provisioning in background")
	return true
}

func engineDriftReason(cfg *config.Config, auth *orchestrator.AuthRetrieveResponse) string {
	if cfg.EngineSuspended(config.EngineClaude) && serverAnsweredForEngine(auth) {
		return "fleet engine switch turned back on"
	}
	if auth.Host == nil {
		return ""
	}
	remote := auth.Host.EnginesList
	if len(remote) == 0 {
		remote = strings.Split(auth.Host.Engines, ",")
	}
	if config.EngineDrift(config.EnabledEngines(cfg.Host, config.EngineClaude), remote) {
		return "host engine set changed (" + strings.Join(remote, ",") + ")"
	}
	// Nil means a server that does not report the switch; it proves nothing.
	if auth.Host.FleetDisabledEngines != nil && config.SuspensionDrift(cfg.Host.FleetDisabledEngines, auth.Host.FleetDisabledEngines) {
		return "fleet engine switch changed"
	}
	return ""
}

// serverAnsweredForEngine reports a positive /auth answer for this engine. The
// server refuses a fleet-disabled engine with 403 engine_disabled, so any of
// these statuses proves the switch is on again.
func serverAnsweredForEngine(auth *orchestrator.AuthRetrieveResponse) bool {
	switch strings.ToLower(strings.TrimSpace(auth.Status)) {
	case "valid", "current", "ok", "unchanged", "updated", "outdated", "missing", "upload_required":
		return true
	}
	return false
}

// applyLocalSuspension keeps the signed config's fleet suspension in force
// whenever the server gave no authoritative answer (outage, server error):
// cached credentials must never become a way around the master switch. A
// positive server answer leaves the decision alone — reconcileEngineDrift then
// refreshes the stale signed config — and every refusal already refuses.
func applyLocalSuspension(cfg *config.Config, dec orchestrator.AuthDecision) orchestrator.AuthDecision {
	if !cfg.EngineSuspended(config.EngineClaude) {
		return dec
	}
	switch strings.ToLower(strings.TrimSpace(dec.Status)) {
	case "offline", "error", "":
	default:
		return dec
	}
	dec.Allowed = false
	dec.LocalUsable = false
	dec.NeedsApprovalPoll = false
	dec.Status = orchestrator.AuthStatusSuspended
	dec.Reason = config.FleetDisabledMessage(config.EngineClaude)
	return dec
}

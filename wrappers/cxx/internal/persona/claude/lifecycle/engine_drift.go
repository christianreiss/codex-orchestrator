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
// the server's engine set differs from the locally baked one, so an engine
// enabled or disabled by an operator is provisioned on this launch rather
// than after the next scheduled tick. The coordinator rewrites the local
// config, which clears the drift.
func reconcileEngineDrift(cfg *config.Config, auth *orchestrator.AuthRetrieveResponse, logger *slog.Logger) bool {
	if cfg == nil || auth == nil || auth.Host == nil {
		return false
	}
	remote := auth.Host.EnginesList
	if len(remote) == 0 {
		remote = strings.Split(auth.Host.Engines, ",")
	}
	if !config.EngineDrift(config.EnabledEngines(cfg.Host, config.EngineClaude), remote) {
		return false
	}
	if err := requestMaintenanceNow(config.EngineClaude, cfg.SourcePath()); err != nil {
		logger.Debug("engine-change maintenance request deferred", "err", err)
		return false
	}
	logger.Info("host engine set changed; provisioning in background", "engines", strings.Join(remote, ","))
	return true
}

package codex

import (
	"context"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/modelpolicy"
)

// CheckModelSupport probes the actual selected native binary only when the
// selected model has a known minimum. Updates and diagnostics never need it.
func CheckModelSupport(ctx context.Context, cfg *config.Config, args []string) error {
	if cfg == nil {
		return nil
	}
	home, err := CodexHome()
	if err != nil {
		return err
	}
	model, err := modelpolicy.SelectedModel(cfg, applyLaneAndProfile(cfg, args), home)
	if err != nil {
		return err
	}
	var catalog *config.ModelCatalog
	if cfg != nil {
		catalog = cfg.EngineOptions.ModelCatalog
	}
	if config.ModelMinimum(config.EngineCodex, model, catalog) == "" {
		return nil
	}
	probe, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return config.CheckModelVersion(config.EngineCodex, model, Version(probe), catalog)
}

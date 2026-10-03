package grok

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
)

// ReconcilePeer is used by both established personas to add the third engine.
// Removal requires a fresh desired list and touches only wrapper-owned state.
func ReconcilePeer(ctx context.Context, cfg *config.Config, engines []string, removeDisabled bool) error {
	desired := false
	for _, engine := range engines {
		if engine == config.EngineGrok {
			desired = true
		}
	}
	path, err := config.DefaultPathForEngine(config.EngineGrok)
	if err != nil {
		return err
	}
	if !desired {
		if !removeDisabled {
			return nil
		}
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return nil
		} else if err != nil {
			return err
		}
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		if err := layout.RemoveAlias(ctx, filepath.Dir(exe), config.EngineGrok); err != nil {
			return err
		}
		return fleetconfig.Remove(ctx, config.EngineGrok)
	}
	fetched, err := fleetconfig.Fetch(ctx, cfg, config.EngineGrok)
	if errors.Is(err, fleetconfig.ErrEngineDisabled) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := fleetconfig.Persist(ctx, fetched); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if _, err := layout.EnsureAliases(ctx, exe, engines); err != nil {
		return err
	}
	// Suspended fleet-wide: keep the config and alias, install nothing.
	if fetched.Config.EngineSuspended(config.EngineGrok) {
		return nil
	}
	if _, err := FindCLI(); err != nil {
		_, err = Install(ctx, PinnedVersion)
		return err
	}
	return nil
}

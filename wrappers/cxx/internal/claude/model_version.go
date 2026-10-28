package claude

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/modelpolicy"
)

// CheckModelSupport refuses a root launch whose selected model needs a newer
// Claude Code than the binary that would run. The binary is probed only when
// the model has a known minimum; native subcommands (update, install, doctor,
// auth, mcp, ...) and help/version never select a model, so recovery remains
// available on an old client.
func CheckModelSupport(ctx context.Context, cfg *config.Config, args []string) error {
	if cfg == nil {
		return nil
	}
	if _, subcommand := NativeSubcommandIndex(args); subcommand {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	model, err := modelpolicy.SelectedClaudeModel(cfg, args, filepath.Join(home, ".claude"), NativeOptionValueEnd)
	if err != nil {
		return err
	}
	catalog := cfg.EngineOptions.ModelCatalog
	if config.ModelMinimum(config.EngineClaude, model, catalog) == "" {
		return nil
	}
	probe, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return config.CheckModelVersion(config.EngineClaude, model, Version(probe), catalog)
}

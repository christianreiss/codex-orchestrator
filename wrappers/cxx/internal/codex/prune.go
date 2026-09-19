package codex

import (
	"log/slog"
	"os"
	"path/filepath"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/enginestore"
)

// codexInstallLock is the flock EnsureCodexBackground holds across its staged
// download, so a sweep that takes it cannot race an install.
const codexInstallLock = ".install.lock"

// ManagedCodexRoot is the private Codex version store.
func ManagedCodexRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cxx", "engines", "codex"), nil
}

// PruneEngineStore removes every Codex prefix under ~/.cxx/engines/codex except
// the one the published pointer (~/.config/codex-orchestrator/cdx-codex-bin)
// selects. See claude.PruneEngineStore for why this belongs to the tick rather
// than to the installer.
func PruneEngineStore(logger *slog.Logger) ([]string, error) {
	root, err := ManagedCodexRoot()
	if err != nil {
		return nil, err
	}
	cli, err := FindCLI()
	if err != nil {
		if logger != nil {
			logger.Warn("Codex engine sweep skipped: no published CLI", "err", err)
		}
		return nil, nil
	}
	return enginestore.PruneEngine(root, cli, codexInstallLock, logger)
}

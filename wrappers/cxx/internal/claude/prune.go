package claude

import (
	"log/slog"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/enginestore"
)

// claudeInstallLock is the flock EnsureClaudeBackground holds for the whole
// staged npm install. A sweep must take the same file so it cannot delete a
// stage mid-install.
const claudeInstallLock = "install.lock"

// PruneEngineStore removes every Claude prefix under ~/.cxx/engines/claude
// except the one the published pointer (~/.clx/state/claude-bin) selects.
//
// It is called from the maintenance tick rather than from the installer: a
// sweep run immediately after publication would race a session that has read
// the pointer but not yet exec'd it, and that process is still clx, so no
// in-use check can see it. Sweeping against the pointer as it stands at the
// start of a tick gives a just-superseded prefix a full tick of grace.
//
// An operator-selected CLI (CLX_CLAUDE_BIN) is not ours to reclaim around, and
// FindCLI may resolve to it, so KeepFor's out-of-root guard turns the sweep
// into a no-op there.
func PruneEngineStore(logger *slog.Logger) ([]string, error) {
	root, err := managedClaudeRoot()
	if err != nil {
		return nil, err
	}
	cli, err := FindCLI()
	if err != nil {
		if logger != nil {
			logger.Warn("Claude engine sweep skipped: no published CLI", "err", err)
		}
		return nil, nil
	}
	return enginestore.PruneEngine(root, cli, claudeInstallLock, logger)
}

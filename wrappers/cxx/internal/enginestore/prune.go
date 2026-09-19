// Package enginestore owns the retention policy for the private engine version
// stores at ~/.cxx/engines/<engine>. The fleet keeps exactly one version on
// disk: the one the published pointer selects. An up- or downgrade is a fresh
// download into a fresh prefix, never a switch back to a retained copy.
package enginestore

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

// KeepFor reduces a published CLI path to the version directory directly below
// root, which is the one entry a sweep must preserve. It returns "" when the
// CLI is empty, unresolvable, or lives outside root -- a pointer the caller
// cannot vouch for must never be turned into a wipe of everything else.
func KeepFor(root, cli string) string {
	if strings.TrimSpace(root) == "" || strings.TrimSpace(cli) == "" {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	if resolved, err := filepath.EvalSymlinks(cli); err == nil {
		cli = resolved
	}
	rel, err := filepath.Rel(root, cli)
	if err != nil {
		return ""
	}
	first, _, _ := strings.Cut(rel, string(os.PathSeparator))
	if first == "" || first == "." || first == ".." {
		return ""
	}
	return first
}

// Prune removes every version directory under root except keep. It is the only
// thing that reclaims an engine prefix, so it is deliberately conservative:
//
//   - keep == "" is a no-op. A missing or unreadable pointer means we do not
//     know which prefix is live, and guessing would uninstall the engine.
//   - A directory a live process still runs from is left for a later sweep.
//     Unlinking it would break that session's lazy reads (plugins, sourcemaps,
//     re-exec) even though its already-mapped pages survive.
//   - The caller must be able to take lockName, the same flock the engine's
//     installer holds across its whole staged install. During an npm install
//     the staged prefix has no engine process running from it -- the live
//     process is npm/node -- so the in-use check cannot see it, and only the
//     lock keeps a concurrent tick from deleting the stage mid-install.
//     ipc.ErrHeld means an installer is working; skip this sweep.
//
// Only directories are considered; the lock files live in the same root.
func Prune(root, keep, lockName string, logger *slog.Logger) ([]string, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("engine store prune requires a root")
	}
	if keep == "" {
		logger.Warn("engine store sweep skipped: no published version to keep", "root", root)
		return nil, nil
	}
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(root, lockName))
	if err != nil {
		if errors.Is(err, ipc.ErrHeld) {
			logger.Debug("engine store sweep skipped: installer holds the lock", "root", root)
			return nil, nil
		}
		return nil, fmt.Errorf("engine store sweep lock: %w", err)
	}
	defer lock.Release()

	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var removed []string
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == keep {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		if inUse(dir) {
			logger.Info("engine store sweep kept a version still in use", "dir", dir)
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			// One unreadable prefix must not stop the rest of the sweep; the
			// next tick retries it.
			logger.Warn("engine store sweep could not remove a version", "dir", dir, "err", err)
			continue
		}
		removed = append(removed, entry.Name())
	}
	if len(removed) > 0 {
		logger.Info("engine store swept superseded versions", "root", root, "kept", keep, "removed", removed)
	}
	return removed, nil
}

// PruneEngine resolves keep from a published CLI path and sweeps root.
func PruneEngine(root, cli, lockName string, logger *slog.Logger) ([]string, error) {
	return Prune(root, KeepFor(root, cli), lockName, logger)
}

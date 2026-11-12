// Package enginestore owns the retention policy for the private engine version
// stores at ~/.cxx/engines/<engine>. The fleet keeps exactly one version on
// disk: the one the published pointer selects. An up- or downgrade is a fresh
// download into a fresh prefix, never a switch back to a retained copy.
package enginestore

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"

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
	if keep == "" {
		return nil, nil
	}
	return sweep(root, lockName, logger, func() (string, error) { return keep, nil }, false)
}

// PruneEngineResolved reads the published pointer under the install lock. Pressure
// cleanup may only revisit candidates admitted by a prior maintenance sweep for
// this same current prefix; a new publication invalidates that admission.
func PruneEngineResolved(root, lockName string, logger *slog.Logger, resolve func() (string, error), pressure bool) ([]string, error) {
	return sweep(root, lockName, logger, func() (string, error) {
		cli, err := resolve()
		if err != nil {
			return "", nil
		} // Unknown publication must never authorize deletion.
		return KeepFor(root, cli), nil
	}, pressure)
}

func sweep(root, lockName string, logger *slog.Logger, resolve func() (string, error), pressure bool) ([]string, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("engine store prune requires a root")
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

	keep, err := resolve()
	if err != nil {
		return nil, err
	}
	if keep == "" {
		logger.Warn("engine store sweep skipped: no published version to keep", "root", root)
		return nil, nil
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	currentInfo, err := os.Stat(filepath.Join(root, keep))
	if err != nil {
		return nil, err
	}
	admission := sweepAdmission{Keep: keep, KeepIdentity: directoryIdentity(currentInfo), Candidates: map[string]string{}}
	if pressure {
		raw, err := os.ReadFile(filepath.Join(root, admissionName))
		var prior sweepAdmission
		if err != nil || json.Unmarshal(raw, &prior) != nil || admission.KeepIdentity == "" || prior.Keep != keep || prior.KeepIdentity != admission.KeepIdentity {
			logger.Info("engine pressure cleanup skipped: no prior maintenance admission for current prefix", "root", root)
			return nil, nil
		}
		admission = prior
	} else {
		for _, entry := range entries {
			if !entry.IsDir() || entry.Name() == keep {
				continue
			}
			if info, err := entry.Info(); err == nil {
				admission.Candidates[entry.Name()] = directoryIdentity(info)
			}
		}
		if err := writeAdmission(root, admission); err != nil {
			// A full disk must not prevent the regular sweep from freeing space. A
			// missing/stale admission only restricts subsequent pressure cleanup.
			logger.Warn("engine sweep could not record pressure-cleanup admission", "root", root, "err", err)
		}
	}
	var removed []string
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == keep {
			continue
		}
		if pressure {
			info, err := entry.Info()
			if err != nil || admission.Candidates[entry.Name()] == "" || admission.Candidates[entry.Name()] != directoryIdentity(info) {
				continue
			}
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

const admissionName = ".pressure-cleanup.json"

type sweepAdmission struct {
	Keep         string            `json:"keep"`
	KeepIdentity string            `json:"keep_identity"`
	Candidates   map[string]string `json:"candidates"`
}

func directoryIdentity(info os.FileInfo) string {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	return fmt.Sprintf("%d:%d", st.Dev, st.Ino)
}
func writeAdmission(root string, admission sweepAdmission) error {
	raw, err := json.Marshal(admission)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(root, ".pressure-cleanup-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(raw)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(root, admissionName))
}

// InvalidatePressureAdmission runs under the engine install lock before every
// managed publication. Even republishing an existing prefix must not reactivate
// an older sweep's admission after an intervening selection.
func InvalidatePressureAdmission(root string) error {
	err := os.Remove(filepath.Join(root, admissionName))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

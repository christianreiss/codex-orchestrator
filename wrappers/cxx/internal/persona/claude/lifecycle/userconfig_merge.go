// userconfig_merge.go syncs the fleet-managed MCP servers into ~/.claude.json.
//
// Claude Code does NOT read `mcpServers` from ~/.claude/settings.json — user-scope
// MCP servers live at the TOP LEVEL of ~/.claude.json (the same file `claude mcp
// add --scope user` writes). The server still ships the managed servers inside the
// claude_settings partial as `mcpServers.<name>` owned paths; applyManagedSettings
// splits those out before the settings.json merge and routes them here. Because
// the split removes `mcpServers.*` from the owned set, the settings.json merge
// self-cleans any block a previous wrapper version put there.
//
// ~/.claude.json is Claude Code's primary stateful file (oauth account, project
// trust, onboarding) so this mirrors settings_merge.go's discipline exactly:
// touch only the managed `mcpServers` leaves, track managed names in a sidecar
// (~/.clx/state/managed-mcp.json) so renames/removals clean up, fail safe on an
// unparseable user file, write atomically preserving the existing file mode.
//
// Every read-modify-rename of ~/.claude.json runs under Claude Code's own config
// lock (claudeconfiglock: the `~/.claude.json.lock` directory that native
// saveConfigWithLock and `claude mcp add/remove` take). The read happens under
// the lock so a native save cannot land between our read and our rename. A live
// holder that outlasts the short budget defers this round: nothing is written,
// the managed-mcp sidecar is left as it was, and the next sync retries.
package lifecycle

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claudeconfiglock"
)

type managedMcpState struct {
	Version int      `json:"version"`
	Names   []string `json:"names"`
}

func managedMcpStatePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".clx", "state", "managed-mcp.json")
}

func userConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude.json")
}

func loadManagedMcpState() managedMcpState {
	st := managedMcpState{Version: 1, Names: []string{}}
	raw, err := os.ReadFile(managedMcpStatePath())
	if err != nil {
		return st
	}
	var parsed managedMcpState
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return st
	}
	if parsed.Names == nil {
		parsed.Names = []string{}
	}
	return parsed
}

func saveManagedMcpState(st managedMcpState) error {
	st.Version = 1
	if st.Names == nil {
		st.Names = []string{}
	}
	body, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(managedMcpStatePath(), body, 0o600)
}

// splitMcpOwned partitions the fleet owned paths: `mcpServers.<name>` entries are
// resolved against the partial and returned as the managed server map (destined
// for ~/.claude.json); everything else stays in the settings.json owned set.
func splitMcpOwned(partial map[string]any, ownedPaths []string) (map[string]any, []string) {
	servers := map[string]any{}
	rest := make([]string, 0, len(ownedPaths))
	for _, p := range ownedPaths {
		name, ok := strings.CutPrefix(p, "mcpServers.")
		if !ok || name == "" {
			rest = append(rest, p)
			continue
		}
		if v, found := getAtPath(partial, p); found {
			servers[name] = v
		}
		// Owned-but-absent means the fleet retired the server this run: it must
		// not re-enter settings.json, and the sidecar diff below removes it from
		// ~/.claude.json.
	}
	return servers, rest
}

// ErrUserConfigUnparseable mirrors ErrUserSettingsUnparseable for ~/.claude.json:
// a NON-EMPTY file that does not parse is never overwritten — it carries oauth
// account state, project trust, and onboarding flags the user cannot recover.
var ErrUserConfigUnparseable = errors.New("user .claude.json is not valid JSON; refusing to overwrite")

// MergeUserMcpServers is the pure merge: given the user's current ~/.claude.json
// bytes, the fleet-managed servers, and the previously managed names, it returns
// the merged bytes plus the new managed-name list. Only the managed entries under
// the top-level `mcpServers` key are touched; user-authored servers and every
// other key survive verbatim.
func MergeUserMcpServers(userRaw []byte, servers map[string]any, prevNames []string) ([]byte, []string, error) {
	root := map[string]any{}
	if strings.TrimSpace(string(userRaw)) != "" {
		if err := json.Unmarshal(userRaw, &root); err != nil || root == nil {
			return nil, nil, ErrUserConfigUnparseable
		}
	}
	cur, _ := root["mcpServers"].(map[string]any)
	if cur == nil {
		cur = map[string]any{}
	}
	for _, name := range prevNames {
		if _, ok := servers[name]; !ok {
			delete(cur, name)
		}
	}
	names := make([]string, 0, len(servers))
	for name, v := range servers {
		cur[name] = v
		names = append(names, name)
	}
	sort.Strings(names)
	if len(cur) > 0 {
		root["mcpServers"] = cur
	} else {
		delete(root, "mcpServers")
	}
	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	out = append(out, '\n')
	return out, names, nil
}

// applyUserMcpServers merges the managed MCP servers into ~/.claude.json, persists
// the managed-mcp sidecar, and returns whether the on-disk file changed.
func applyUserMcpServers(servers map[string]any, logger *slog.Logger) bool {
	changed, _ := applyUserMcpServersResult(servers, logger)
	return changed
}

// ErrUserConfigLocked reports a ~/.claude.json update deferred because Claude
// Code held its config lock for the whole retry budget. Nothing was written and
// the managed-mcp sidecar is unchanged, so the next sync retries the update.
var ErrUserConfigLocked = errors.New("~/.claude.json update deferred: Claude Code holds its config lock")

// userConfigLockOptions is the test seam for the lock budget and clock.
var userConfigLockOptions claudeconfiglock.Options

// withUserConfigLock runs fn while holding Claude Code's config lock for path.
// fn must read the file inside the lock and call check immediately before its
// rename; a lost lock means the write must not land. It never falls back to an
// unlocked write.
func withUserConfigLock(path, op string, logger *slog.Logger, fn func(check func() error) error) error {
	lockPath := claudeconfiglock.Path(path)
	lock, err := claudeconfiglock.Acquire(path, userConfigLockOptions)
	if err != nil {
		if errors.Is(err, claudeconfiglock.ErrLocked) {
			logger.Warn("deferring ~/.claude.json update to the next sync; Claude Code holds its config lock", "op", op, "lock", lockPath, "err", err)
			return fmt.Errorf("%w: %w", ErrUserConfigLocked, err)
		}
		logger.Warn("skipping ~/.claude.json update; Claude Code config lock unavailable", "op", op, "lock", lockPath, "err", err)
		return fmt.Errorf("acquire Claude Code config lock: %w", err)
	}
	defer func() {
		if rerr := lock.Release(); rerr != nil {
			logger.Warn("Claude Code config lock release failed", "op", op, "lock", lockPath, "err", rerr)
		}
	}()
	return fn(lock.Check)
}

func applyUserMcpServersResult(servers map[string]any, logger *slog.Logger) (bool, error) {
	prev := loadManagedMcpState()
	if len(servers) == 0 && len(prev.Names) == 0 {
		return false, nil
	}
	path := userConfigPath()
	var changed bool
	var names []string
	err := withUserConfigLock(path, "mcp-merge", logger, func(check func() error) error {
		var merr error
		changed, names, merr = mergeUserMcpServersLocked(path, servers, prev.Names, logger, check)
		return merr
	})
	if err != nil {
		return false, err
	}
	if serr := saveManagedMcpState(managedMcpState{Version: 1, Names: names}); serr != nil {
		logger.Debug("managed-mcp state write failed", "err", serr)
		return changed, serr
	}
	return changed, nil
}

// mergeUserMcpServersLocked is the read-modify-rename; the caller holds the lock.
func mergeUserMcpServersLocked(path string, servers map[string]any, prevNames []string, logger *slog.Logger, check func() error) (bool, []string, error) {
	userRaw, readErr := os.ReadFile(path)
	if readErr != nil && !os.IsNotExist(readErr) {
		return false, nil, fmt.Errorf("read user MCP config: %w", readErr)
	}
	merged, names, err := MergeUserMcpServers(userRaw, servers, prevNames)
	if err != nil {
		// Fail safe: leave the user's .claude.json untouched this run.
		logger.Warn("skipping MCP merge to avoid clobbering unparseable user .claude.json", "path", path, "err", err)
		return false, nil, err
	}
	changed := !bytesEqual(userRaw, merged)
	if changed {
		// Preserve the existing mode; Claude Code keeps oauth state in this file,
		// so a freshly created one is private.
		mode := os.FileMode(0o600)
		if fi, serr := os.Stat(path); serr == nil {
			mode = fi.Mode().Perm()
		}
		if cerr := check(); cerr != nil {
			return false, nil, cerr
		}
		if werr := atomicWrite(path, merged, mode); werr != nil {
			logger.Debug("merged .claude.json write failed", "err", werr)
			return false, nil, werr
		}
	}
	return changed, names, nil
}

// stripUserMcpServers removes every fleet-managed MCP server from ~/.claude.json
// (trust-loss counterpart of stripManagedSettings); user servers survive.
func stripUserMcpServers(logger *slog.Logger) error {
	return stripUserMcpServersWith(logger, atomicWrite)
}

func stripUserMcpServersWith(logger *slog.Logger, write func(string, []byte, os.FileMode) error) error {
	prev := loadManagedMcpState()
	if len(prev.Names) == 0 {
		return nil
	}
	path := userConfigPath()
	if _, serr := os.Lstat(path); os.IsNotExist(serr) {
		// Nothing to strip: no lock needed to clear the ownership sidecar.
		if err := saveManagedMcpState(managedMcpState{Version: 1, Names: []string{}}); err != nil {
			return fmt.Errorf("clear managed MCP ownership: %w", err)
		}
		return nil
	}
	err := withUserConfigLock(path, "mcp-strip", logger, func(check func() error) error {
		userRaw, readErr := os.ReadFile(path)
		if os.IsNotExist(readErr) {
			return nil
		}
		if readErr != nil {
			return fmt.Errorf("read user MCP config: %w", readErr)
		}
		merged, _, err := MergeUserMcpServers(userRaw, map[string]any{}, prev.Names)
		if err != nil {
			logger.Warn("skipping MCP strip; user .claude.json unparseable", "err", err)
			return err
		}
		if bytesEqual(userRaw, merged) {
			return nil
		}
		mode := os.FileMode(0o600)
		if fi, serr := os.Stat(path); serr == nil {
			mode = fi.Mode().Perm()
		}
		if err := check(); err != nil {
			return err
		}
		if err := write(path, merged, mode); err != nil {
			logger.Warn("MCP strip write failed; retaining ownership for retry", "err", err)
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := saveManagedMcpState(managedMcpState{Version: 1, Names: []string{}}); err != nil {
		return fmt.Errorf("clear managed MCP ownership: %w", err)
	}
	return nil
}

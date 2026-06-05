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
package lifecycle

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
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
		if err := json.Unmarshal(userRaw, &root); err != nil {
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
	prev := loadManagedMcpState()
	if len(servers) == 0 && len(prev.Names) == 0 {
		return false
	}
	path := userConfigPath()
	userRaw, _ := os.ReadFile(path)
	merged, names, err := MergeUserMcpServers(userRaw, servers, prev.Names)
	if err != nil {
		// Fail safe: leave the user's .claude.json untouched this run.
		logger.Warn("skipping MCP merge to avoid clobbering unparseable user .claude.json", "path", path, "err", err)
		return false
	}
	changed := !bytesEqual(userRaw, merged)
	if changed {
		// Preserve the existing mode; Claude Code keeps oauth state in this file,
		// so a freshly created one is private.
		mode := os.FileMode(0o600)
		if fi, serr := os.Stat(path); serr == nil {
			mode = fi.Mode().Perm()
		}
		if werr := atomicWrite(path, merged, mode); werr != nil {
			logger.Debug("merged .claude.json write failed", "err", werr)
			return false
		}
	}
	if serr := saveManagedMcpState(managedMcpState{Version: 1, Names: names}); serr != nil {
		logger.Debug("managed-mcp state write failed", "err", serr)
	}
	return changed
}

// stripUserMcpServers removes every fleet-managed MCP server from ~/.claude.json
// (trust-loss counterpart of stripManagedSettings); user servers survive.
func stripUserMcpServers(logger *slog.Logger) {
	prev := loadManagedMcpState()
	if len(prev.Names) == 0 {
		return
	}
	path := userConfigPath()
	userRaw, _ := os.ReadFile(path)
	merged, _, err := MergeUserMcpServers(userRaw, map[string]any{}, prev.Names)
	if err != nil {
		logger.Warn("skipping MCP strip; user .claude.json unparseable", "err", err)
		return
	}
	if !bytesEqual(userRaw, merged) {
		mode := os.FileMode(0o600)
		if fi, serr := os.Stat(path); serr == nil {
			mode = fi.Mode().Perm()
		}
		_ = atomicWrite(path, merged, mode)
	}
	_ = saveManagedMcpState(managedMcpState{Version: 1, Names: []string{}})
}

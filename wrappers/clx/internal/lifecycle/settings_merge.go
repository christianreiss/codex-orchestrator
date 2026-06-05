// settings_merge.go deep-merges the fleet-managed Claude settings partial into
// the user's ~/.claude/settings.json WITHOUT clobbering user-owned keys.
//
// Contract (server side renderClaudeSettingsPartial):
//   - The bundle returns {partial, owned_paths}: `partial` holds only fleet keys;
//     `owned_paths` are leaf dot-paths the fleet owns this run (e.g. "model",
//     "mcpServers.clx", "env.FOO", "statusLine", "hooks.PreToolUse",
//     "permissions.deny").
//   - We persist owned_paths + the fleet permission rules to a sidecar
//     (~/.clx/state/managed-keys.json). Next run, paths in the sidecar but no
//     longer owned are deleted — that is how a removed hook / env var gets
//     cleaned up. The server stays stateless.
//   - `mcpServers.<name>` owned paths are NOT settings.json keys: Claude Code
//     reads user-scope MCP servers from ~/.claude.json. They are split out
//     before the merge and applied there (userconfig_merge.go); since they
//     leave the owned set, the stale-path pass removes the inert block older
//     wrappers wrote into settings.json.
//   - Object blocks (env.*, hooks.*, statusLine) merge by leaf path so
//     user-authored siblings survive. The permissions.{allow,ask,deny}
//     arrays are union(user-minus-prev-fleet, current-fleet) — user rules kept,
//     our previously-injected rules refreshed, no duplicates.
package lifecycle

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
)

type managedState struct {
	Version         int                 `json:"version"`
	KeyPaths        []string            `json:"key_paths"`
	PermissionRules map[string][]string `json:"permission_rules"`
}

var permissionPaths = map[string]bool{
	"permissions.allow": true,
	"permissions.ask":   true,
	"permissions.deny":  true,
}

func managedStatePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".clx", "state", "managed-keys.json")
}

func loadManagedState() managedState {
	st := managedState{Version: 1, KeyPaths: []string{}, PermissionRules: map[string][]string{}}
	raw, err := os.ReadFile(managedStatePath())
	if err != nil {
		return st
	}
	var parsed managedState
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return st
	}
	if parsed.PermissionRules == nil {
		parsed.PermissionRules = map[string][]string{}
	}
	return parsed
}

func saveManagedState(st managedState) error {
	st.Version = 1
	if st.PermissionRules == nil {
		st.PermissionRules = map[string][]string{}
	}
	body, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(managedStatePath(), body, 0o600)
}

// --- dot-path helpers over map[string]any -----------------------------------

// splitPath splits a dot-path. NOTE: keys containing a literal '.' (an env var
// or MCP server name with a dot) would split wrong — acceptable because managed
// owned_paths only ever use UPPER_SNAKE env vars, the `clx` server name, and
// fixed hook-event names, none of which contain dots.
func splitPath(p string) []string { return strings.Split(p, ".") }

func getAtPath(root map[string]any, path string) (any, bool) {
	parts := splitPath(path)
	var cur any = root
	for _, part := range parts {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		v, ok := m[part]
		if !ok {
			return nil, false
		}
		cur = v
	}
	return cur, true
}

func setAtPath(root map[string]any, path string, value any) {
	parts := splitPath(path)
	cur := root
	for i := 0; i < len(parts)-1; i++ {
		next, ok := cur[parts[i]].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[parts[i]] = next
		}
		cur = next
	}
	cur[parts[len(parts)-1]] = value
}

// deleteAtPath removes a leaf and prunes any parent objects it leaves empty.
func deleteAtPath(root map[string]any, path string) {
	parts := splitPath(path)
	// Walk down collecting the chain of maps.
	chain := []map[string]any{root}
	cur := root
	for i := 0; i < len(parts)-1; i++ {
		next, ok := cur[parts[i]].(map[string]any)
		if !ok {
			return // path absent; nothing to delete
		}
		chain = append(chain, next)
		cur = next
	}
	delete(cur, parts[len(parts)-1])
	// Prune empty parents bottom-up.
	for i := len(chain) - 1; i >= 1; i-- {
		if len(chain[i]) == 0 {
			delete(chain[i-1], parts[i-1])
		} else {
			break
		}
	}
}

func toStringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func subtract(base, remove []string) []string {
	drop := map[string]bool{}
	for _, r := range remove {
		drop[r] = true
	}
	out := []string{}
	for _, b := range base {
		if !drop[b] {
			out = append(out, b)
		}
	}
	return out
}

func dedupKeepOrder(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// MergeSettings is the pure merge: it never touches disk or the network. Given
// the user's current settings bytes, the fleet partial, the owned paths, and the
// previous managed state, it returns the merged settings bytes and the new state.
// ErrUserSettingsUnparseable signals that a NON-EMPTY user settings.json could
// not be parsed. Callers MUST NOT write in this case — overwriting a file the
// user owns (Go's json is stricter than Claude Code's reader: JSONC, trailing
// commas, BOM) is exactly the clobber the merge exists to prevent. Fail safe:
// skip the merge for this run; a missed fleet update is recoverable, lost user
// settings are not.
var ErrUserSettingsUnparseable = errors.New("user settings.json is not valid JSON; refusing to overwrite")

func MergeSettings(userRaw []byte, partial map[string]any, ownedPaths []string, prev managedState) ([]byte, managedState, error) {
	merged := map[string]any{}
	if strings.TrimSpace(string(userRaw)) != "" {
		if err := json.Unmarshal(userRaw, &merged); err != nil {
			return nil, prev, ErrUserSettingsUnparseable
		}
	}

	ownedSet := map[string]bool{}
	for _, p := range ownedPaths {
		ownedSet[p] = true
	}

	// 1. Apply current owned (non-permission) paths from the partial.
	for _, p := range ownedPaths {
		if permissionPaths[p] {
			continue
		}
		if v, ok := getAtPath(partial, p); ok {
			setAtPath(merged, p, v)
		} else {
			deleteAtPath(merged, p)
		}
	}

	// 2. Remove stale fleet paths (previously owned, no longer owned).
	for _, p := range prev.KeyPaths {
		if permissionPaths[p] || ownedSet[p] {
			continue
		}
		deleteAtPath(merged, p)
	}

	// 3. Permissions buckets: union(user − prevFleet, currentFleet), deduped.
	curFleet := map[string][]string{}
	if pv, ok := getAtPath(partial, "permissions"); ok {
		if pm, ok := pv.(map[string]any); ok {
			for _, bucket := range []string{"allow", "ask", "deny"} {
				if ownedSet["permissions."+bucket] {
					curFleet[bucket] = toStringSlice(pm[bucket])
				}
			}
		}
	}
	for _, bucket := range []string{"allow", "ask", "deny"} {
		path := "permissions." + bucket
		var userArr []string
		if v, ok := getAtPath(merged, path); ok {
			userArr = toStringSlice(v)
		}
		kept := subtract(userArr, prev.PermissionRules[bucket])
		newArr := dedupKeepOrder(append(kept, curFleet[bucket]...))
		if len(newArr) > 0 {
			anyArr := make([]any, len(newArr))
			for i, s := range newArr {
				anyArr[i] = s
			}
			setAtPath(merged, path, anyArr)
		} else {
			deleteAtPath(merged, path)
		}
	}

	newState := managedState{Version: 1, KeyPaths: ownedPaths, PermissionRules: curFleet}
	out, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return nil, prev, err
	}
	out = append(out, '\n')
	return out, newState, nil
}

// applyManagedSettings merges the bundle's claude_settings partial into
// ~/.claude/settings.json (and mirrors to ~/.clx/config/settings.json), persists
// the new managed-keys sidecar, and returns whether the on-disk file changed.
// The `mcpServers.<name>` owned paths are split out first and routed into
// ~/.claude.json (see userconfig_merge.go) — Claude Code only reads user-scope
// MCP servers from there; dropping them from the owned set lets the merge below
// self-clean the inert block older wrapper versions left in settings.json.
func applyManagedSettings(cs *orchestrator.ClaudeSettings, logger *slog.Logger) bool {
	if cs == nil || len(cs.Partial) == 0 {
		return false
	}
	var partial map[string]any
	if err := json.Unmarshal(cs.Partial, &partial); err != nil {
		logger.Debug("claude_settings partial decode failed", "err", err)
		return false
	}
	mcpServers, ownedPaths := splitMcpOwned(partial, cs.OwnedPaths)
	mcpChanged := applyUserMcpServers(mcpServers, logger)
	path := settingsPath()
	userRaw, _ := os.ReadFile(path)
	merged, newState, err := MergeSettings(userRaw, partial, ownedPaths, loadManagedState())
	if err != nil {
		// Fail safe: leave the user's settings.json untouched this run.
		logger.Warn("skipping settings merge to avoid clobbering unparseable user settings.json", "path", path, "err", err)
		return mcpChanged
	}
	changed := !bytesEqual(userRaw, merged)
	if changed {
		if err := atomicWrite(path, merged, 0o644); err != nil {
			logger.Debug("merged settings write failed", "err", err)
			return mcpChanged
		}
		if home, herr := os.UserHomeDir(); herr == nil {
			_ = atomicWrite(filepath.Join(home, ".clx", "config", "settings.json"), merged, 0o644)
		}
	}
	if serr := saveManagedState(newState); serr != nil {
		logger.Debug("managed-keys state write failed", "err", serr)
	}
	return changed || mcpChanged
}

// stripManagedSettings removes every fleet-owned key from ~/.claude/settings.json
// plus the fleet MCP servers from ~/.claude.json (used when a host loses trust).
// Reuses the merge with an empty partial so user keys survive; clears the sidecars.
func stripManagedSettings(logger *slog.Logger) {
	stripUserMcpServers(logger)
	prev := loadManagedState()
	if len(prev.KeyPaths) == 0 {
		return
	}
	path := settingsPath()
	userRaw, _ := os.ReadFile(path)
	merged, _, err := MergeSettings(userRaw, map[string]any{}, []string{}, prev)
	if err != nil {
		logger.Warn("skipping settings strip; user settings.json unparseable", "err", err)
		return
	}
	if !bytesEqual(userRaw, merged) {
		_ = atomicWrite(path, merged, 0o644)
	}
	_ = saveManagedState(managedState{Version: 1, KeyPaths: []string{}, PermissionRules: map[string][]string{}})
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

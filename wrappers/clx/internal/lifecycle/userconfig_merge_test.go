package lifecycle

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
)

func TestSplitMcpOwned(t *testing.T) {
	partial := map[string]any{
		"model": "sonnet",
		"mcpServers": map[string]any{
			"clx": map[string]any{"type": "http", "url": "https://x/mcp"},
		},
	}
	owned := []string{"model", "mcpServers.clx", "mcpServers.retired"}
	servers, rest := splitMcpOwned(partial, owned)
	if len(servers) != 1 {
		t.Fatalf("want 1 server, got %v", servers)
	}
	if _, ok := servers["clx"]; !ok {
		t.Error("clx server must be extracted from the partial")
	}
	// `mcpServers.retired` is owned but absent from the partial: it must not
	// re-enter the settings.json owned set (the sidecar diff removes it from
	// ~/.claude.json instead).
	if len(rest) != 1 || rest[0] != "model" {
		t.Errorf("rest must hold only non-MCP paths, got %v", rest)
	}
}

func TestMergeUserMcpServersCreatesAndPreserves(t *testing.T) {
	user := []byte(`{"hasCompletedOnboarding":true,"mcpServers":{"mine":{"command":"./x"}},"oauthAccount":{"id":"u1"}}`)
	servers := map[string]any{"clx": map[string]any{"type": "http", "url": "https://x/mcp"}}
	out, names, err := MergeUserMcpServers(user, servers, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := parseObj(t, out)
	if m["hasCompletedOnboarding"] != true {
		t.Error("unrelated keys must survive")
	}
	if _, ok := m["oauthAccount"]; !ok {
		t.Error("oauth state must survive")
	}
	mcp := m["mcpServers"].(map[string]any)
	if _, ok := mcp["mine"]; !ok {
		t.Error("user-authored server must survive")
	}
	if _, ok := mcp["clx"]; !ok {
		t.Error("managed clx server must be added")
	}
	if len(names) != 1 || names[0] != "clx" {
		t.Errorf("managed names must be tracked, got %v", names)
	}
}

func TestMergeUserMcpServersEmptyFile(t *testing.T) {
	out, _, err := MergeUserMcpServers(nil, map[string]any{"clx": map[string]any{"url": "u"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := parseObj(t, out)
	if _, ok := m["mcpServers"].(map[string]any)["clx"]; !ok {
		t.Error("fresh .claude.json must carry the managed server")
	}
}

func TestMergeUserMcpServersRemovesStaleManaged(t *testing.T) {
	user := []byte(`{"mcpServers":{"clx":{"url":"old"},"mine":{"command":"./x"}}}`)
	out, names, err := MergeUserMcpServers(user, map[string]any{}, []string{"clx"})
	if err != nil {
		t.Fatal(err)
	}
	m := parseObj(t, out)
	mcp := m["mcpServers"].(map[string]any)
	if _, ok := mcp["clx"]; ok {
		t.Error("retired managed server must be removed")
	}
	if _, ok := mcp["mine"]; !ok {
		t.Error("user-authored server must survive removal pass")
	}
	if len(names) != 0 {
		t.Errorf("no managed names expected, got %v", names)
	}
}

func TestMergeUserMcpServersPrunesEmptyBlock(t *testing.T) {
	user := []byte(`{"theme":"x","mcpServers":{"clx":{"url":"old"}}}`)
	out, _, err := MergeUserMcpServers(user, map[string]any{}, []string{"clx"})
	if err != nil {
		t.Fatal(err)
	}
	m := parseObj(t, out)
	if _, ok := m["mcpServers"]; ok {
		t.Error("emptied mcpServers block must be pruned")
	}
	if m["theme"] != "x" {
		t.Error("user key must survive")
	}
}

func TestMergeUserMcpServersRefusesUnparseable(t *testing.T) {
	_, _, err := MergeUserMcpServers([]byte("{not json"), map[string]any{"clx": map[string]any{}}, nil)
	if err != ErrUserConfigUnparseable {
		t.Fatalf("want ErrUserConfigUnparseable, got %v", err)
	}
}

// End-to-end through applyManagedSettings: mcpServers.* owned paths land in
// ~/.claude.json, NOT settings.json; an inert block an older wrapper left in
// settings.json is self-cleaned; strip removes the managed server again.
func TestApplyManagedSettingsRoutesMcpToUserConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	settingsFile := filepath.Join(home, ".claude", "settings.json")
	userConfigFile := filepath.Join(home, ".claude.json")
	if err := os.MkdirAll(filepath.Dir(settingsFile), 0o755); err != nil {
		t.Fatal(err)
	}
	// Simulate the pre-fix state: an older wrapper run left the managed block in
	// settings.json and recorded mcpServers.clx in the managed-keys sidecar.
	if err := os.WriteFile(settingsFile, []byte(`{"theme":"dark","mcpServers":{"clx":{"type":"http","url":"https://x/mcp"}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := saveManagedState(managedState{Version: 1, KeyPaths: []string{"model", "mcpServers.clx"}, PermissionRules: map[string][]string{}}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userConfigFile, []byte(`{"hasCompletedOnboarding":true}`), 0o600); err != nil {
		t.Fatal(err)
	}

	cs := &orchestrator.ClaudeSettings{
		Status:     "updated",
		Partial:    json.RawMessage(`{"model":"sonnet","mcpServers":{"clx":{"type":"http","url":"https://x/mcp","headers":{"Authorization":"Bearer t"}}}}`),
		OwnedPaths: []string{"model", "mcpServers.clx"},
	}
	if !applyManagedSettings(cs, logger) {
		t.Fatal("first apply should report a change")
	}

	settings := parseObj(t, readFile(t, settingsFile))
	if _, ok := settings["mcpServers"]; ok {
		t.Error("stale mcpServers block must be removed from settings.json")
	}
	if settings["model"] != "sonnet" || settings["theme"] != "dark" {
		t.Errorf("settings merge regressed: %v", settings)
	}

	userCfg := parseObj(t, readFile(t, userConfigFile))
	if userCfg["hasCompletedOnboarding"] != true {
		t.Error("user .claude.json keys must survive")
	}
	clx, ok := userCfg["mcpServers"].(map[string]any)["clx"].(map[string]any)
	if !ok || clx["url"] != "https://x/mcp" {
		t.Fatalf("managed clx server must land in .claude.json, got %v", userCfg["mcpServers"])
	}

	// Idempotent re-apply is a no-op on disk.
	if applyManagedSettings(cs, logger) {
		t.Error("idempotent re-apply should report no change")
	}

	stripManagedSettings(logger)
	stripped := parseObj(t, readFile(t, userConfigFile))
	if _, ok := stripped["mcpServers"]; ok {
		t.Error("strip must remove the managed server from .claude.json")
	}
	if stripped["hasCompletedOnboarding"] != true {
		t.Error("strip must keep user .claude.json keys")
	}
}

func TestApplyUserMcpServersLeavesUnparseableUntouched(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	userConfigFile := filepath.Join(home, ".claude.json")
	original := []byte("{broken json\n")
	if err := os.WriteFile(userConfigFile, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if applyUserMcpServers(map[string]any{"clx": map[string]any{"url": "u"}}, slog.Default()) {
		t.Fatal("must report no change when refusing to merge")
	}
	if !bytesEqual(readFile(t, userConfigFile), original) {
		t.Fatal("unparseable user .claude.json MUST be left byte-identical")
	}
}

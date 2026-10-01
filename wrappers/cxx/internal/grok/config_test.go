package grok

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pelletier/go-toml"
)

func TestConfigPartialPreservesUserValuesAndPrunesOnlyUnchangedFleetPaths(t *testing.T) {
	r, _ := runtimeFixture(t)
	path := filepath.Join(r.BaseHome, "config.toml")
	if err := AtomicWrite(path, []byte("[models]\nuser_setting='keep'\n[mcp_servers.mine]\ncommand='user-tool'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	body := []byte("[models]\ndefault='grok-4.6'\ndefault_reasoning_effort='high'\n[mcp_servers.\"fleet.with.dot\"]\nurl='https://example.invalid/mcp'\nheaders={X-API-Key='fake-host-key'}\n")
	owned := []string{"models.default", "models.default_reasoning_effort", "mcp_servers.fleet.with.dot"}
	if err := SyncConfig(r.BaseHome, body, owned); err != nil {
		t.Fatal(err)
	}
	state, _ := StateDir()
	manifest, _ := os.ReadFile(filepath.Join(state, "managed-keys.json"))
	if strings.Contains(string(manifest), "fake-host-key") {
		t.Fatal("managed sidecar duplicated an MCP credential")
	}
	data, _ := os.ReadFile(path)
	tree, _ := toml.LoadBytes(data)
	m := tree.ToMap()
	m["models"].(map[string]any)["default"] = "user-edited-model"
	tree, _ = toml.TreeFromMap(m)
	text, _ := tree.ToTomlString()
	if err := AtomicWrite(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SyncConfig(r.BaseHome, nil, []string{}); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(path)
	tree, _ = toml.LoadBytes(data)
	m = tree.ToMap()
	models := m["models"].(map[string]any)
	if models["default"] != "user-edited-model" || models["user_setting"] != "keep" {
		t.Fatal("subsequent user edit or sibling key removed")
	}
	if models["default_reasoning_effort"] != nil {
		t.Fatal("ceased-owned fleet effort retained")
	}
	servers := m["mcp_servers"].(map[string]any)
	if servers["mine"] == nil || servers["fleet.with.dot"] != nil {
		t.Fatal("MCP pruning confused dotted names or user server")
	}
	var stateDoc configOwnership
	if json.Unmarshal(manifest, &stateDoc) != nil {
		t.Fatal("invalid ownership sidecar")
	}
}

func TestOwnedMCPTransportChangesRemoveRetiredFields(t *testing.T) {
	r, _ := runtimeFixture(t)
	owned := []string{"mcp_servers.fleet"}
	if err := SyncConfig(r.BaseHome, []byte("[mcp_servers.fleet]\nurl='https://example.invalid/mcp'\nheaders={Authorization='retired-fixture'}\n[mcp_servers.mine]\ncommand='keep'\n"), owned); err != nil {
		t.Fatal(err)
	}
	if err := SyncConfig(r.BaseHome, []byte("[mcp_servers.fleet]\ncommand='new-tool'\nargs=['--stdio']\n"), owned); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(r.BaseHome, "config.toml"))
	tree, err := toml.LoadBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	servers := tree.ToMap()["mcp_servers"].(map[string]any)
	fleet := servers["fleet"].(map[string]any)
	if fleet["url"] != nil || fleet["headers"] != nil || fleet["command"] != "new-tool" || servers["mine"] == nil {
		t.Fatal("retired managed transport survived or user server was removed")
	}
}

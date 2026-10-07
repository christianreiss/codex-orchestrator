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

func TestContextWindowOwnershipPreservesModelSiblingsAndPrunesOnModelSwitch(t *testing.T) {
	r, _ := runtimeFixture(t)
	path := filepath.Join(r.BaseHome, "config.toml")
	if err := AtomicWrite(path, []byte("[model.\"grok-4.7\"]\ntemperature=0.5\n[model.custom]\ncontext_window=128000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, model := range []string{"grok-4.7", "grok-4.7-build-fast"} {
		body := []byte("[model.\"" + model + "\"]\ncontext_window=500000\n")
		owned := []string{"model." + model + ".context_window"}
		if err := SyncConfig(r.BaseHome, body, owned); err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := os.ReadFile(path)
	tree, err := toml.LoadBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if tree.GetPath([]string{"model", "grok-4.7", "context_window"}) != nil {
		t.Fatal("previous model retained the retired fleet context window")
	}
	if tree.GetPath([]string{"model", "grok-4.7", "temperature"}) != 0.5 || tree.GetPath([]string{"model", "custom", "context_window"}) != int64(128000) {
		t.Fatal("user model settings were changed")
	}
	if tree.GetPath([]string{"model", "grok-4.7-build-fast", "context_window"}) != int64(500000) {
		t.Fatal("new model did not receive the fleet context window")
	}
	// A local edit after sync is no longer the fleet's value to prune.
	tree.SetPath([]string{"model", "grok-4.7-build-fast", "context_window"}, int64(256000))
	body, err := tree.ToTomlString()
	if err != nil {
		t.Fatal(err)
	}
	if err := AtomicWrite(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SyncConfig(r.BaseHome, nil, []string{}); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(path)
	tree, err = toml.LoadBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if tree.GetPath([]string{"model", "grok-4.7-build-fast", "context_window"}) != int64(256000) {
		t.Fatal("subsequent local edit was pruned")
	}
}

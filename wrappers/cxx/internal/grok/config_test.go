package grok

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pelletier/go-toml"
)

func TestNativeNestedOwnershipKeepsLiteralKeysAndLocalSiblings(t *testing.T) {
	r, _ := runtimeFixture(t)
	path := filepath.Join(r.BaseHome, "config.toml")
	if err := AtomicWrite(path, []byte("[model.\"grok-4.7\".extra_headers]\nuser='keep'\n[ui]\ntheme='local'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	body := []byte("[model.\"grok-4.7\".extra_headers]\n\"X.Team\"='fleet'\n[ui]\ntimestamps='minimal'\n")
	owned := []string{`json:["model","grok-4.7","extra_headers","X.Team"]`, "ui.timestamps"}
	if err := SyncConfig(r.BaseHome, body, owned); err != nil {
		t.Fatal(err)
	}
	if err := SyncConfig(r.BaseHome, nil, []string{}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	tree, err := toml.LoadBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if tree.GetPath([]string{"model", "grok-4.7", "extra_headers", "X.Team"}) != nil || tree.GetPath([]string{"ui", "timestamps"}) != nil {
		t.Fatal("ceased-owned native fields were not pruned")
	}
	if tree.GetPath([]string{"model", "grok-4.7", "extra_headers", "user"}) != "keep" || tree.GetPath([]string{"ui", "theme"}) != "local" {
		t.Fatal("native pruning removed user-authored sibling values")
	}
}

func TestInvalidNativeOwnershipEncodingDoesNotPublishConfig(t *testing.T) {
	for _, owned := range []string{"json:broken", "json:null", "json:[]", "json:[1]", `json:["ui",""]`, `json:["ui","bad\nkey"]`} {
		t.Run(owned, func(t *testing.T) {
			r, _ := runtimeFixture(t)
			path := filepath.Join(r.BaseHome, "config.toml")
			before := "[ui]\ntheme='local'\n"
			if err := AtomicWrite(path, []byte(before), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := SyncConfig(r.BaseHome, []byte("[ui]\ntheme='fleet'\n"), []string{owned}); err == nil {
				t.Fatal("malformed ownership path accepted")
			}
			raw, _ := os.ReadFile(path)
			if string(raw) != before {
				t.Fatal("invalid ownership changed native config")
			}
		})
	}
}

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

func TestConfigOwnershipRecoversInterruptedPublication(t *testing.T) {
	for _, phase := range []string{"before-config", "after-config", "user-edit"} {
		t.Run(phase, func(t *testing.T) {
			r, _ := runtimeFixture(t)
			if err := SyncConfig(r.BaseHome, []byte("[models]\ndefault='old-fleet'\nuser='keep'\n"), []string{"models.default"}); err != nil {
				t.Fatal(err)
			}
			state, _ := StateDir()
			journal := configJournal{Previous: configOwnership{Version: 1, Paths: map[string]string{"models.default": configValueDigest("old-fleet")}}, Next: configOwnership{Version: 1, Paths: map[string]string{"models.default": configValueDigest("new-fleet")}}}
			raw, _ := json.Marshal(journal)
			if err := AtomicWrite(filepath.Join(state, "managed-keys.pending.json"), raw, 0600); err != nil {
				t.Fatal(err)
			}
			value := "old-fleet"
			if phase == "after-config" {
				value = "new-fleet"
			}
			if phase == "user-edit" {
				value = "user-model"
			}
			if err := AtomicWrite(filepath.Join(r.BaseHome, "config.toml"), []byte("[models]\ndefault='"+value+"'\nuser='keep'\n"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := SyncConfig(r.BaseHome, nil, []string{}); err != nil {
				t.Fatal(err)
			}
			data, _ := os.ReadFile(filepath.Join(r.BaseHome, "config.toml"))
			tree, err := toml.LoadBytes(data)
			if err != nil {
				t.Fatal(err)
			}
			want := any(nil)
			if phase == "user-edit" {
				want = "user-model"
			}
			if got := tree.Get("models.default"); got != want {
				t.Fatalf("ownership recovery: got%v want%v", got, want)
			}
			if tree.Get("models.user") != "keep" {
				t.Fatal("user setting lost")
			}
			if _, err := os.Stat(filepath.Join(state, "managed-keys.pending.json")); !os.IsNotExist(err) {
				t.Fatal("committed journal remains", err)
			}
		})
	}
}

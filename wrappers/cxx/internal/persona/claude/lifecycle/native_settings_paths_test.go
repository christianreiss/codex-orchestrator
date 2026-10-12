package lifecycle

import "testing"

func TestNativeSettingsLiteralMapKeysAndRemoval(t *testing.T) {
	user := []byte(`{"modelSettings":{"vendor.model":{"maxEffortLevel":"high","autoCompactWindow":300000},"other-model":{"effortLevel":"low"}},"enabledPlugins":{"user@local.example":true}}`)
	partial := map[string]any{
		"modelSettings":  map[string]any{"vendor.model": map[string]any{"effortLevel": "high"}},
		"enabledPlugins": map[string]any{"review@fleet.example": true},
	}
	paths := []string{`json:["modelSettings","vendor.model","effortLevel"]`, `json:["enabledPlugins","review@fleet.example"]`}
	out, state, err := MergeSettings(user, partial, paths, emptyState())
	if err != nil {
		t.Fatal(err)
	}
	root := parseObj(t, out)
	model := root["modelSettings"].(map[string]any)["vendor.model"].(map[string]any)
	if model["effortLevel"] != "high" || model["maxEffortLevel"] != "high" || model["autoCompactWindow"] != float64(300000) {
		t.Fatalf("literal model key or user siblings lost: %s", out)
	}
	if _, wrong := root["modelSettings"].(map[string]any)["vendor"]; wrong {
		t.Fatalf("literal dot was interpreted as nesting: %s", out)
	}
	second, _, err := MergeSettings(out, partial, paths, state)
	if err != nil || string(second) != string(out) {
		t.Fatalf("merge not idempotent: %v\n%s", err, second)
	}
	removed, _, err := MergeSettings(out, map[string]any{}, nil, state)
	if err != nil {
		t.Fatal(err)
	}
	root = parseObj(t, removed)
	model = root["modelSettings"].(map[string]any)["vendor.model"].(map[string]any)
	if _, exists := model["effortLevel"]; exists || model["maxEffortLevel"] != "high" {
		t.Fatalf("stale leaf cleanup lost user settings: %s", removed)
	}
	plugins := root["enabledPlugins"].(map[string]any)
	if _, exists := plugins["review@fleet.example"]; exists || plugins["user@local.example"] != true {
		t.Fatalf("stale plugin cleanup lost user plugin: %s", removed)
	}
}

func TestNativeSettingsOwnershipMovesFromObjectToLeaves(t *testing.T) {
	user := []byte(`{"statusLine":{"type":"command","command":"old","padding":1},"theme":"dark"}`)
	partial := map[string]any{"statusLine": map[string]any{"type": "command", "command": "new", "hideVimModeIndicator": true}}
	previous := managedState{KeyPaths: []string{"statusLine"}}
	out, _, err := MergeSettings(user, partial, []string{"statusLine.type", "statusLine.command", "statusLine.hideVimModeIndicator"}, previous)
	if err != nil {
		t.Fatal(err)
	}
	root := parseObj(t, out)
	line, ok := root["statusLine"].(map[string]any)
	if !ok || line["command"] != "new" || line["hideVimModeIndicator"] != true || root["theme"] != "dark" {
		t.Fatalf("old parent cleanup erased new leaves: %s", out)
	}
}

func TestNativeSettingsRejectsMalformedOwnedPaths(t *testing.T) {
	for _, path := range []string{`json:[]`, `json:null`, `json:[1]`, `json:["env",""]`, `json:["env","__proto__"]`, `json:broken`} {
		if _, _, err := MergeSettings([]byte(`{"theme":"dark"}`), map[string]any{}, []string{path}, emptyState()); err == nil {
			t.Errorf("malformed path accepted: %s", path)
		}
	}
}

func TestClaudeEffortMigrationAndModelSwitch(t *testing.T) {
	user := []byte(`{"model":"claude-opus-4-7","effortLevel":"xhigh","modelSettings":{"claude-opus-5-5":{"autoCompactWindow":300000},"claude-sonnet-4-6":{"maxEffortLevel":"high"},"custom.model":{"effortLevel":"low"}}}`)
	partial := map[string]any{"model": "claude-opus-5-5", "modelSettings": map[string]any{"claude-opus-5-5": map[string]any{"effortLevel": "high"}}}
	prev := managedState{KeyPaths: []string{"model", "effortLevel"}}
	out, state, err := MergeSettings(user, partial, []string{"model", "modelSettings.claude-opus-5-5.effortLevel"}, prev)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := parseObj(t, out)["effortLevel"]; exists {
		t.Fatalf("old fleet top-level effort survived migration: %s", out)
	}
	second := map[string]any{"model": "claude-sonnet-4-6", "effortLevel": "medium", "modelSettings": map[string]any{"claude-sonnet-4-6": map[string]any{"effortLevel": "medium"}}}
	switched, switchedState, err := MergeSettings(out, second, []string{"model", "effortLevel", "modelSettings.claude-sonnet-4-6.effortLevel"}, state)
	if err != nil {
		t.Fatal(err)
	}
	models := parseObj(t, switched)["modelSettings"].(map[string]any)
	opus := models["claude-opus-5-5"].(map[string]any)
	if _, exists := opus["effortLevel"]; exists || opus["autoCompactWindow"] != float64(300000) {
		t.Fatalf("old model cleanup lost siblings: %s", switched)
	}
	sonnet := models["claude-sonnet-4-6"].(map[string]any)
	if sonnet["effortLevel"] != "medium" || sonnet["maxEffortLevel"] != "high" || models["custom.model"].(map[string]any)["effortLevel"] != "low" {
		t.Fatalf("model switch lost user settings: %s", switched)
	}
	noEffort, _, err := MergeSettings(switched, map[string]any{"model": "claude-haiku-4-5-20251001"}, []string{"model"}, switchedState)
	if err != nil {
		t.Fatal(err)
	}
	root := parseObj(t, noEffort)
	if _, exists := root["effortLevel"]; exists {
		t.Fatalf("unsupported top-level effort survived: %s", noEffort)
	}
	models = root["modelSettings"].(map[string]any)
	sonnet = models["claude-sonnet-4-6"].(map[string]any)
	if _, exists := sonnet["effortLevel"]; exists || sonnet["maxEffortLevel"] != "high" {
		t.Fatalf("unsupported effort cleanup lost user sibling: %s", noEffort)
	}
}

package lifecycle

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

func parseObj(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("merged not valid JSON: %v\n%s", err, b)
	}
	return m
}

func emptyState() managedState {
	return managedState{Version: 1, KeyPaths: []string{}, PermissionRules: map[string][]string{}}
}

func TestMergePreservesUserKeysAndAddsFleet(t *testing.T) {
	user := []byte(`{"theme":"dark","env":{"MY_VAR":"1"}}`)
	partial := map[string]any{"model": "sonnet", "env": map[string]any{"FLEET_VAR": "x"}}
	owned := []string{"model", "env.FLEET_VAR"}
	out, _, err := MergeSettings(user, partial, owned, emptyState())
	if err != nil {
		t.Fatal(err)
	}
	m := parseObj(t, out)
	if m["theme"] != "dark" {
		t.Error("user theme must survive")
	}
	if m["model"] != "sonnet" {
		t.Error("fleet model must be added")
	}
	env := m["env"].(map[string]any)
	if env["MY_VAR"] != "1" {
		t.Error("user env sibling MY_VAR must survive")
	}
	if env["FLEET_VAR"] != "x" {
		t.Error("fleet env var must be added")
	}
}

func TestMergeRemovesStaleFleetPath(t *testing.T) {
	// Previously the fleet owned env.OLD and statusLine; now it owns neither.
	user := []byte(`{"env":{"OLD":"v","USER":"keep"},"statusLine":{"type":"command"},"theme":"x"}`)
	prev := managedState{KeyPaths: []string{"env.OLD", "statusLine"}, PermissionRules: map[string][]string{}}
	out, st, err := MergeSettings(user, map[string]any{}, []string{}, prev)
	if err != nil {
		t.Fatal(err)
	}
	m := parseObj(t, out)
	env := m["env"].(map[string]any)
	if _, ok := env["OLD"]; ok {
		t.Error("stale fleet env.OLD must be removed")
	}
	if env["USER"] != "keep" {
		t.Error("user env.USER must survive stale removal")
	}
	if _, ok := m["statusLine"]; ok {
		t.Error("stale fleet statusLine must be removed")
	}
	if m["theme"] != "x" {
		t.Error("unrelated user key must survive")
	}
	if len(st.KeyPaths) != 0 {
		t.Error("new state should own nothing")
	}
}

func TestMergePermissionsUnionAndPrevFleetStrip(t *testing.T) {
	// User has their own deny rule + one the fleet injected last run (rm -rf).
	user := []byte(`{"permissions":{"deny":["Bash(sudo *)","Bash(rm -rf *)"]}}`)
	prev := managedState{KeyPaths: []string{"permissions.deny"}, PermissionRules: map[string][]string{"deny": {"Bash(rm -rf *)"}}}
	// This run the fleet denies a different command.
	partial := map[string]any{"permissions": map[string]any{"deny": []any{"Bash(curl *)"}}}
	out, st, err := MergeSettings(user, partial, []string{"permissions.deny"}, prev)
	if err != nil {
		t.Fatal(err)
	}
	m := parseObj(t, out)
	deny := toStringSlice(m["permissions"].(map[string]any)["deny"])
	// User's own rule kept; old fleet rule dropped; new fleet rule added.
	want := []string{"Bash(sudo *)", "Bash(curl *)"}
	if !reflect.DeepEqual(deny, want) {
		t.Errorf("deny = %v, want %v", deny, want)
	}
	if !reflect.DeepEqual(st.PermissionRules["deny"], []string{"Bash(curl *)"}) {
		t.Errorf("new state fleet deny = %v", st.PermissionRules["deny"])
	}
}

func TestMergeDefaultModeScalarCoexistsWithBuckets(t *testing.T) {
	// permissions.defaultMode is a plain scalar leaf — NOT one of the
	// allow/ask/deny union buckets — so it must ride the generic dotted merge,
	// survive alongside a deny bucket, and not be pruned.
	user := []byte(`{"permissions":{"deny":["Bash(sudo *)"]}}`)
	partial := map[string]any{
		"permissions": map[string]any{
			"defaultMode": "auto",
			"deny":        []any{"Bash(curl *)"},
		},
	}
	owned := []string{"permissions.defaultMode", "permissions.deny"}
	out, st, err := MergeSettings(user, partial, owned, emptyState())
	if err != nil {
		t.Fatal(err)
	}
	perms := parseObj(t, out)["permissions"].(map[string]any)
	if perms["defaultMode"] != "auto" {
		t.Errorf("defaultMode = %v, want auto", perms["defaultMode"])
	}
	deny := toStringSlice(perms["deny"])
	if !reflect.DeepEqual(deny, []string{"Bash(sudo *)", "Bash(curl *)"}) {
		t.Errorf("deny = %v; user rule + fleet rule expected", deny)
	}

	// Next run the fleet owns nothing: the stale-path pass must strip
	// defaultMode and our previously-injected deny rule, leaving only the
	// user-authored deny rule intact.
	out2, _, err := MergeSettings(out, map[string]any{}, []string{}, st)
	if err != nil {
		t.Fatal(err)
	}
	perms2 := parseObj(t, out2)["permissions"].(map[string]any)
	if _, ok := perms2["defaultMode"]; ok {
		t.Error("defaultMode must be removed once the fleet stops owning it")
	}
	if got := toStringSlice(perms2["deny"]); !reflect.DeepEqual(got, []string{"Bash(sudo *)"}) {
		t.Errorf("after strip deny = %v, want user rule only", got)
	}
}

func TestMergeEmptyUserSettings(t *testing.T) {
	out, _, err := MergeSettings(nil, map[string]any{"model": "opus"}, []string{"model"}, emptyState())
	if err != nil {
		t.Fatal(err)
	}
	if parseObj(t, out)["model"] != "opus" {
		t.Error("merge into empty settings should yield the fleet model")
	}
}

func TestMergeIsIdempotent(t *testing.T) {
	partial := map[string]any{"model": "sonnet", "hooks": map[string]any{"PreToolUse": []any{}}}
	owned := []string{"model", "hooks.PreToolUse"}
	first, st, _ := MergeSettings([]byte(`{"theme":"x"}`), partial, owned, emptyState())
	second, _, _ := MergeSettings(first, partial, owned, st)
	if !bytesEqual(first, second) {
		t.Errorf("merge must be idempotent:\n%s\n---\n%s", first, second)
	}
}

func TestMergeRefusesToClobberUnparseableUserSettings(t *testing.T) {
	// JSONC / trailing comma: Claude Code reads it, Go's json rejects it.
	for _, bad := range []string{
		"{\n  \"model\": \"x\", // a comment\n}",
		`{"a":1,}`,
		"\xef\xbb\xbf{\"a\":1}", // BOM
		"not json at all",
	} {
		_, _, err := MergeSettings([]byte(bad), map[string]any{"model": "sonnet"}, []string{"model"}, emptyState())
		if err == nil {
			t.Fatalf("expected refusal for unparseable user settings %q", bad)
		}
	}
}

func TestApplyManagedSettingsLeavesUnparseableFileUntouched(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	settingsFile := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsFile), 0o755); err != nil {
		t.Fatal(err)
	}
	original := []byte("{\n  \"theme\": \"dark\", // user's JSONC\n}\n")
	if err := os.WriteFile(settingsFile, original, 0o644); err != nil {
		t.Fatal(err)
	}
	cs := &orchestrator.ClaudeSettings{Partial: json.RawMessage(`{"model":"sonnet"}`), OwnedPaths: []string{"model"}}
	changed, err := applyManagedSettingsResult(cs, slog.Default())
	if changed || err == nil {
		t.Fatalf("refused merge = (%t, %v), want unchanged warning", changed, err)
	}
	if !bytesEqual(readFile(t, settingsFile), original) {
		t.Fatal("unparseable user settings.json MUST be left byte-identical")
	}
}

func TestDeleteAtPathPrunesEmptyParents(t *testing.T) {
	root := map[string]any{"env": map[string]any{"ONLY": "v"}}
	deleteAtPath(root, "env.ONLY")
	if _, ok := root["env"]; ok {
		t.Error("emptied parent object should be pruned")
	}
}

func TestApplyAndStripManagedSettings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	settingsFile := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsFile, []byte(`{"theme":"solarized"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	cs := &orchestrator.ClaudeSettings{
		Status:     "updated",
		Partial:    json.RawMessage(`{"model":"sonnet","statusLine":{"type":"command","command":"x"}}`),
		OwnedPaths: []string{"model", "statusLine"},
	}
	if !applyManagedSettings(cs, logger) {
		t.Fatal("first apply should report a change")
	}
	m := parseObj(t, readFile(t, settingsFile))
	if m["theme"] != "solarized" || m["model"] != "sonnet" {
		t.Errorf("apply did not merge correctly: %v", m)
	}
	// Second identical apply is a no-op on disk.
	if applyManagedSettings(cs, logger) {
		t.Error("idempotent re-apply should report no change")
	}

	stripManagedSettings(logger)
	m2 := parseObj(t, readFile(t, settingsFile))
	if _, ok := m2["model"]; ok {
		t.Error("strip must remove fleet model")
	}
	if _, ok := m2["statusLine"]; ok {
		t.Error("strip must remove fleet statusLine")
	}
	if m2["theme"] != "solarized" {
		t.Error("strip must keep the user key")
	}
}

func TestStripManagedSettingsRetriesFailedMirrorWrite(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.Default()
	cs := &orchestrator.ClaudeSettings{
		Status:     "updated",
		Partial:    json.RawMessage(`{"model":"sonnet"}`),
		OwnedPaths: []string{"model"},
	}
	if !applyManagedSettings(cs, logger) {
		t.Fatal("managed settings were not applied")
	}
	mirror := filepath.Join(home, ".clx", "config", "settings.json")
	err := stripManagedSettingsWith(logger, func(path string, body []byte, mode os.FileMode) error {
		if path == mirror {
			return errors.New("mirror busy")
		}
		return atomicWrite(path, body, mode)
	})
	if err == nil || len(loadManagedState().KeyPaths) == 0 {
		t.Fatalf("failed strip cleared retry state: err=%v state=%+v", err, loadManagedState())
	}
	if _, ok := parseObj(t, readFile(t, mirror))["model"]; !ok {
		t.Fatal("injected mirror failure did not preserve stale managed key")
	}
	if err := stripManagedSettings(logger); err != nil {
		t.Fatalf("retry strip: %v", err)
	}
	if _, ok := parseObj(t, readFile(t, mirror))["model"]; ok || len(loadManagedState().KeyPaths) != 0 {
		t.Fatalf("retry did not strip mirror/state: state=%+v", loadManagedState())
	}
}

func TestMergeAdvisorModelSetAndStaleRemoval(t *testing.T) {
	// (a) A new top-level scalar advisorModel is written without dropping user keys.
	user := []byte(`{"theme":"dark","advisorModel":"opus","extra":1}`)
	partial := map[string]any{"advisorModel": "opus"}
	out, st, err := MergeSettings(user, partial, []string{"advisorModel"}, emptyState())
	if err != nil {
		t.Fatal(err)
	}
	m := parseObj(t, out)
	if m["advisorModel"] != "opus" {
		t.Errorf("fleet advisorModel must be set, got %v", m["advisorModel"])
	}
	if m["theme"] != "dark" || m["extra"] != float64(1) {
		t.Errorf("user keys must survive: %v", m)
	}

	// (b) When the fleet stops owning advisorModel (off), it is removed.
	out2, _, err := MergeSettings(out, map[string]any{}, []string{}, st)
	if err != nil {
		t.Fatal(err)
	}
	m2 := parseObj(t, out2)
	if _, ok := m2["advisorModel"]; ok {
		t.Error("stale fleet advisorModel must be removed when no longer owned")
	}
	if m2["theme"] != "dark" {
		t.Error("user key must survive stale advisorModel removal")
	}
}

func readFile(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read %s: %v", p, err)
	}
	return b
}

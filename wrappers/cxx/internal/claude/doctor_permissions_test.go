package claude

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
)

func writeDoctorSettings(t *testing.T, body string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// These assert the row content for a given settings file. The root branches only
// exercise when the suite itself runs as root; the parsing and model screen below
// are covered unconditionally.
func TestPermissionRowReflectsTheSettingsFile(t *testing.T) {
	writeDoctorSettings(t, `{"permissions":{"defaultMode":"bypassPermissions"}}`)
	var hints []string
	row := checkPermissions(&hints)

	if os.Geteuid() == 0 {
		if row.Tone != ui.ToneFail {
			t.Fatalf("root + bypassPermissions must FAIL, got tone %v (%q)", row.Tone, row.Value)
		}
		if !strings.Contains(row.Value, "refuse to start") {
			t.Errorf("the row should say what actually happens, got %q", row.Value)
		}
		if len(hints) == 0 {
			t.Error("a FAIL should carry guidance")
		}
		return
	}
	if row.Tone != ui.ToneOK {
		t.Fatalf("non-root is unconstrained, got tone %v (%q)", row.Tone, row.Value)
	}
}

func TestPermissionModeAndModelAreReadFromSettings(t *testing.T) {
	writeDoctorSettings(t, `{"model":"claude-opus-5","permissions":{"defaultMode":"auto"}}`)
	mode, model := claudeSettingsPermissionMode()
	if mode != "auto" || model != "claude-opus-5" {
		t.Fatalf("mode=%q model=%q, want auto / claude-opus-5", mode, model)
	}
}

// Unreadable or unparseable must read as "nothing to report", never as a problem
// of its own — the doctor should not invent a failure out of a missing file.
func TestPermissionReadFailsQuiet(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if mode, model := claudeSettingsPermissionMode(); mode != "" || model != "" {
		t.Fatalf("absent settings: got %q/%q, want empty", mode, model)
	}

	writeDoctorSettings(t, "{not json")
	if mode, _ := claudeSettingsPermissionMode(); mode != "" {
		t.Fatalf("unparseable settings: got %q, want empty", mode)
	}
}

func TestAutoModeModelScreen(t *testing.T) {
	for _, m := range []string{"claude-opus-5", "claude-sonnet-5", "claude-fable-5", ""} {
		if !modelLikelySupportsAutoMode(m) {
			t.Errorf("%q should be treated as auto-capable", m)
		}
	}
	// The families upstream names as unsupported.
	for _, m := range []string{"claude-haiku-4-5-20251001", "claude-3-opus", "claude-sonnet-4-5", "claude-opus-4.5"} {
		if modelLikelySupportsAutoMode(m) {
			t.Errorf("%q is documented as not supporting auto mode", m)
		}
	}
	// An unrecognised model must not produce a warning: this screens what is
	// known, not what it merely fails to recognise.
	if !modelLikelySupportsAutoMode("some-future-model-9") {
		t.Error("an unknown model should not be warned about")
	}
}

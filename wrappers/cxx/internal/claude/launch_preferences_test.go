package claude

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestLaunchPreferencesMatchesNativeFlags(t *testing.T) {
	for _, tc := range []struct {
		name          string
		args          []string
		model, effort string
	}{
		{"long", []string{"--model", "sonnet", "--effort", "high"}, "sonnet", "high"},
		{"equals", []string{"--model=opus", "--effort=max"}, "opus", "max"},
		{"last value wins", []string{"--model", "sonnet", "--model=opus", "--effort=low", "--effort", "MED"}, "opus", "medium"},
		{"no native short aliases", []string{"-m", "sonnet", "-e", "high"}, "", ""},
		{"native sentinel", []string{"--model=sonnet", "--", "--model=opus", "--effort=high"}, "sonnet", ""},
		{"option values are literal", []string{"--system-prompt", "--model=opus", "--append-system-prompt", "--effort=max", "--model=sonnet"}, "sonnet", ""},
		{"short option value is literal", []string{"-n", "--model=opus", "--effort=low"}, "", "low"},
		{"optional resume value", []string{"--resume", "--model=sonnet", "--effort=high"}, "sonnet", "high"},
		{"prompt followed by options", []string{"-p", "describe this code", "--model=sonnet", "--effort=high"}, "sonnet", "high"},
		{"invalid last effort falls back", []string{"--effort=high", "--effort=unknown"}, "", ""},
		{"missing value", []string{"--model"}, "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			model, effort := LaunchPreferences(tc.args)
			if model != tc.model || effort != tc.effort {
				t.Fatalf("preferences = %q / %q, want %q / %q", model, effort, tc.model, tc.effort)
			}
		})
	}
}

func TestRuntimeAuthPreservesInheritedEffort(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLAUDE_CODE_EFFORT_LEVEL", "medium")
	found := false
	for _, entry := range BuildEnv(&config.Config{}) {
		if strings.HasPrefix(entry, "CLAUDE_CODE_EFFORT_LEVEL=") {
			found = entry == "CLAUDE_CODE_EFFORT_LEVEL=medium"
		}
	}
	if !found {
		t.Fatal("native launch environment lost the inherited effort override")
	}
	raw, err := runtimeAuthSettingsJSON(nil)
	if err != nil {
		t.Fatal(err)
	}
	var settings struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	if _, overridden := settings.Env["CLAUDE_CODE_EFFORT_LEVEL"]; overridden {
		t.Fatal("auth overlay replaced the inherited effort override")
	}
}

package summary

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

func TestBuildReflectsClaudeLaunchPreferences(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ANTHROPIC_MODEL", "env-model")
	t.Setenv("CLAUDE_CODE_EFFORT_LEVEL", "")
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(`{"model":"local-model","effortLevel":"low"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	wrapperModel := "wrapper-model"
	for _, tc := range []struct {
		name, env     string
		args          []string
		model, effort string
	}{
		{"long beats managed and local", "", []string{"--model", "sonnet", "--effort", "high"}, "sonnet", "high"},
		{"equals beats managed and local", "", []string{"--model=opus", "--effort=max"}, "opus", "max"},
		{"model keeps fallback effort", "", []string{"--model=sonnet"}, "sonnet", "medium"},
		{"effort keeps fallback model", "", []string{"--effort=high"}, "wrapper-model", "high"},
		{"unsupported short flags", "", []string{"-m", "sonnet", "-e", "high"}, "wrapper-model", "medium"},
		{"literal prompt", "", []string{"--", "--model=sonnet", "--effort=high"}, "wrapper-model", "medium"},
		{"environment wins effort", "low", []string{"--model=sonnet", "--effort=high"}, "sonnet", "low"},
		{"environment auto clears effort", "auto", []string{"--effort=high"}, "wrapper-model", ""},
		{"environment unset clears effort", "unset", []string{"--effort=high"}, "wrapper-model", ""},
		{"invalid environment falls through", "unknown", []string{"--effort=high"}, "wrapper-model", "high"},
		{"environment names do not trim", " low ", []string{"--effort=high"}, "wrapper-model", "high"},
		{"environment accepts zero budget", "0", []string{"--effort=high"}, "wrapper-model", "0"},
		{"invalid native effort falls through", "", []string{"--effort=high", "--effort=unknown"}, "wrapper-model", "medium"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CLAUDE_CODE_EFFORT_LEVEL", tc.env)
			got := Build(context.Background(), Inputs{
				SkipVersionProbe: true,
				LaunchArgs:       tc.args,
				Config: &config.Config{EngineOptions: config.EngineOptions{
					ClaudeModelOverride: &wrapperModel,
				}},
				Auth: &orchestrator.AuthRetrieveResponse{Host: &orchestrator.HostInfo{
					ClaudeModelOverride: "host-model",
					ReasoningEffort:     "medium",
				}},
			})
			if got.Model != tc.model || got.Effort != tc.effort {
				t.Fatalf("header = %q / %q, want %q / %q", got.Model, got.Effort, tc.model, tc.effort)
			}
		})
	}
}

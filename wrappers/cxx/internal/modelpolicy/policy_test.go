package modelpolicy_test

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/modelpolicy"
)

func fixture(engine, old, next string) *config.Config {
	effort := "high"
	return &config.Config{Engine: engine, EngineOptions: config.EngineOptions{
		ModelPolicy:  &config.ModelPolicy{LatestOnly: true, Replacements: map[string]string{old: next, next: next}},
		ModelCatalog: &config.ModelCatalog{DefaultModel: next, Models: []config.ModelCatalogEntry{{Model: next, Efforts: []string{"low", "high"}, DefaultEffort: &effort}}},
	}}
}
func TestUpgradeEveryEngine(t *testing.T) {
	for _, tc := range []struct {
		engine, old, next, file, body string
		args                          []string
	}{
		{"codex", "gpt-5.6-sol", "gpt-6.1-sol", "config.toml", "model='gpt-5.6-sol'\nmodel_reasoning_effort='high'\n", []string{"exec", "prompt"}},
		{"claude", "claude-opus-5", "claude-opus-5-5", "settings.json", `{"model":"claude-opus-5","effortLevel":"high"}`, []string{"-p", "prompt"}},
		{"grok", "grok-4.5", "grok-4.7", "config.toml", "[models]\ndefault='grok-4.5'\ndefault_reasoning_effort='high'\n", []string{"-p", "prompt"}},
	} {
		t.Run(tc.engine, func(t *testing.T) {
			home := t.TempDir()
			path := filepath.Join(home, tc.file)
			os.WriteFile(path, []byte(tc.body), 0600)
			var end modelpolicy.OptionEnd
			if tc.engine == "claude" {
				end = claude.NativeOptionValueEnd
			}
			var notice bytes.Buffer
			got, err := modelpolicy.Apply(fixture(tc.engine, tc.old, tc.next), tc.args, home, end, &notice)
			if err != nil {
				t.Fatal(err)
			}
			if got[0] != "--model" || got[1] != tc.next || !strings.Contains(strings.Join(got, " "), "high") {
				t.Fatalf("args=%q", got)
			}
			if !strings.Contains(notice.String(), tc.old+" → "+tc.next) {
				t.Fatalf("notice=%s", notice.String())
			}
			raw, _ := os.ReadFile(path)
			if string(raw) != tc.body {
				t.Fatal("saved preference changed")
			}
		})
	}
}
func TestArgumentPrecedenceAndBoundaries(t *testing.T) {
	cfg := fixture("codex", "old", "new")
	for _, args := range [][]string{
		{"-mold", "exec", "prompt"}, {"--model=old", "exec", "prompt"},
		{"--config", "model = 'old'", "exec", "prompt"},
		{"--model", "unknown", "--model", "old", "exec", "prompt"},
	} {
		got, err := modelpolicy.Apply(cfg, args, t.TempDir(), nil, nil)
		if err != nil || got[1] != "new" {
			t.Fatalf("%q => %q: %v", args, got, err)
		}
	}
	got, err := modelpolicy.Apply(cfg, []string{"--model", "old", "exec", "--", "--model", "unknown"}, t.TempDir(), nil, nil)
	if err != nil || !reflect.DeepEqual(got[len(got)-3:], []string{"--", "--model", "unknown"}) {
		t.Fatalf("sentinel: %q %v", got, err)
	}
	cfg = fixture("claude", "claude-opus-5", "claude-opus-5-5")
	got, err = modelpolicy.Apply(cfg, []string{"--system-prompt", "--model=unknown", "--model=opus", "--effort=max", "-p", "prompt"}, t.TempDir(), claude.NativeOptionValueEnd, nil)
	if err != nil || got[1] != "claude-opus-5-5" || got[3] != "high" || !strings.Contains(strings.Join(got, " "), "--system-prompt --model=unknown") {
		t.Fatalf("Claude boundaries: %q %v", got, err)
	}
}
func TestClaudeOpaqueVersionTextDoesNotBypassPolicy(t *testing.T) {
	cfg := fixture("claude", "claude-opus-5", "claude-opus-5-5")
	args := []string{"--system-prompt", "--version", "--model", "claude-opus-5", "-p", "prompt"}
	got, err := modelpolicy.Apply(cfg, args, t.TempDir(), claude.NativeOptionValueEnd, nil)
	if err != nil || got[0] != "--model" || got[1] != "claude-opus-5-5" {
		t.Fatalf("policy bypass: %q %v", got, err)
	}
}

func TestProfileWinsOverHostOverride(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "config.toml"), []byte("model='unknown'\n"), 0600)
	os.WriteFile(filepath.Join(home, "review.config.toml"), []byte("model='old'\nmodel_reasoning_effort='low'\n"), 0600)
	cfg := fixture("codex", "old", "new")
	host := "unknown"
	cfg.EngineOptions.ModelOverride = &host
	high := "high"
	cfg.EngineOptions.ReasoningEffortOverride = &high
	got, err := modelpolicy.Apply(cfg, []string{"--profile", "review", "exec", "prompt"}, home, nil, nil)
	if err != nil || got[1] != "new" || got[3] != "model_reasoning_effort=low" {
		t.Fatalf("%q %v", got, err)
	}
}
func TestClaudeExplicitSettings(t *testing.T) {
	cfg := fixture("claude", "claude-opus-5", "claude-opus-5-5")
	got, err := modelpolicy.Apply(cfg, []string{"--settings", `{"model":"claude-opus-5","effortLevel":"low"}`, "-p", "prompt"}, t.TempDir(), claude.NativeOptionValueEnd, nil)
	if err != nil || got[1] != "claude-opus-5-5" || got[3] != "low" {
		t.Fatalf("%q %v", got, err)
	}
}
func TestPolicyOffUnknownAndDisabled(t *testing.T) {
	cfg := fixture("grok", "old", "new")
	args := []string{"--model", "unknown", "-p", "prompt"}
	if _, err := modelpolicy.Apply(cfg, args, t.TempDir(), nil, nil); err == nil {
		t.Fatal("unknown allowed")
	}
	cfg.EngineOptions.ModelPolicy.DisabledModels = []string{"new"}
	if _, err := modelpolicy.Apply(cfg, []string{"--model", "old"}, t.TempDir(), nil, nil); err == nil {
		t.Fatal("disabled allowed")
	}
	cfg.EngineOptions.ModelPolicy.LatestOnly = false
	got, err := modelpolicy.Apply(cfg, args, t.TempDir(), nil, nil)
	if err != nil || !reflect.DeepEqual(got, args) {
		t.Fatal("off policy rewrote args")
	}
	cfg.EngineOptions.ModelPolicy.LatestOnly = true
	got, err = modelpolicy.Apply(cfg, []string{"login", "--device-code"}, t.TempDir(), nil, nil)
	if err != nil || !reflect.DeepEqual(got, []string{"login", "--device-code"}) {
		t.Fatal("login changed")
	}
}

func TestLegacyCodexProfileArray(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "config.toml"), []byte("model='unknown'\n[[profiles]]\nname='review'\nmodel='old'\nmodel_reasoning_effort='low'\n"), 0600)
	got, err := modelpolicy.Apply(fixture("codex", "old", "new"), []string{"-p", "review", "exec", "prompt"}, home, nil, nil)
	if err != nil || got[1] != "new" || got[3] != "model_reasoning_effort=low" {
		t.Fatalf("legacy profile: %q %v", got, err)
	}
}

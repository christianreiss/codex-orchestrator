package launchpad

import (
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
	"strings"
	"testing"
)

func TestTerraSelectionRefusesOldActualVersionWithoutFallback(t *testing.T) {
	for _, missing := range []bool{false, true} {
		catalog := &config.ModelCatalog{DefaultModel: "gpt-6.1-terra", Models: []config.ModelCatalogEntry{{Model: "gpt-6-astra"}}}
		if !missing {
			catalog.Models = append(catalog.Models, config.ModelCatalogEntry{Model: "gpt-6.1-terra", MinCLIVersion: "0.159.0"})
		}
		cfg := signed([]string{"codex"}, catalog)
		for _, version := range []string{"", "0.158.9"} {
			src := Sources{Version: func(string) string { return version }}
			models := menu("codex", cfg, src)
			model, effort := start("codex", cfg, models, src)
			if model != "gpt-6.1-terra" {
				t.Fatalf("silently changed model to %s", model)
			}
			p := newPicker([]Engine{{Name: "codex", Models: models, Model: model, Effort: effort}}, nil, terminalui.Caps{})
			press(t, p, "enter")
			if p.result != nil || !strings.Contains(p.notice, "cdx update") {
				t.Fatalf("old model launched: %v %s", p.result, p.notice)
			}
		}
	}
	cfg := signed([]string{"codex"}, &config.ModelCatalog{DefaultModel: "gpt-6.1-terra", Models: []config.ModelCatalogEntry{{Model: "gpt-6.1-terra", MinCLIVersion: "0.159.0"}}})
	models := menu("codex", cfg, Sources{Version: func(string) string { return "0.159.0" }})
	p := newPicker([]Engine{{Name: "codex", Models: models, Model: "gpt-6.1-terra"}}, nil, terminalui.Caps{})
	press(t, p, "enter")
	if p.result == nil || p.result.Model != "gpt-6.1-terra" {
		t.Fatal("supported model refused")
	}
}

func TestTerraLatestOnlyMissingCatalogEntryDoesNotFallback(t *testing.T) {
	cfg := signed([]string{"codex"}, &config.ModelCatalog{DefaultModel: "gpt-5.6-terra", Models: []config.ModelCatalogEntry{}})
	cfg.EngineOptions.ModelPolicy = &config.ModelPolicy{LatestOnly: true, Replacements: map[string]string{"gpt-5.6-terra": "gpt-6.1-terra"}}
	src := Sources{Version: func(string) string { return "0.158.0" }}
	models := menu("codex", cfg, src)
	selected, _ := start("codex", cfg, models, src)
	if selected != "gpt-6.1-terra" {
		t.Fatalf("lost blocked selection: %s %#v", selected, models)
	}
}

func TestClaudeLaunchpadAppliesDocumentedMinimums(t *testing.T) {
	// Older signed catalog without min_cli_version: the built-in floor still applies.
	old := &config.ModelCatalog{DefaultModel: "claude-sonnet-5", Models: []config.ModelCatalogEntry{{Model: "claude-sonnet-5"}, {Model: "claude-haiku-5-5"}, {Model: "claude-sonnet-5-5"}}}
	for _, tc := range []struct {
		version, model string
		available      bool
	}{
		{"2.1.292", "claude-haiku-5-5", false},
		{"2.1.293", "claude-haiku-5-5", true},
		{"2.1.283", "claude-sonnet-5-5", false},
		{"2.1.284 (Claude Code)", "claude-sonnet-5-5", true},
		{"unknown", "claude-sonnet-5-5", false},
		{"2.1.200", "claude-sonnet-5", true},
	} {
		src := Sources{Version: func(string) string { return tc.version }}
		models := menu("claude", signed([]string{"claude"}, old), src)
		m, ok := findModel(models, tc.model)
		if !ok || (m.Unavailable == "") != tc.available {
			t.Fatalf("%+v: %#v", tc, m)
		}
		if !tc.available && !strings.Contains(m.Unavailable, "clx update") {
			t.Fatalf("unhelpful notice %q", m.Unavailable)
		}
	}
	// A server-filtered catalog keeps the host override visible but unlaunchable.
	cfg := signed([]string{"claude"}, &config.ModelCatalog{DefaultModel: "claude-sonnet-5", Models: []config.ModelCatalogEntry{{Model: "claude-sonnet-5"}}})
	override := "claude-sonnet-5-5"
	cfg.EngineOptions.ClaudeModelOverride = &override
	src := Sources{Version: func(string) string { return "2.1.283" }}
	models := menu("claude", cfg, src)
	model, effort := start("claude", cfg, models, src)
	if model != "claude-sonnet-5-5" {
		t.Fatalf("silently changed model to %s", model)
	}
	p := newPicker([]Engine{{Name: "claude", Models: models, Model: model, Effort: effort}}, nil, terminalui.Caps{})
	press(t, p, "enter")
	if p.result != nil || !strings.Contains(p.notice, "clx update") || strings.Contains(p.notice, "cdx") {
		t.Fatalf("old Claude launched: %v %s", p.result, p.notice)
	}
}

package grok

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
)

func TestRuntimeOverlayModelSelectionReachesStartupAndPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, overlay, model, effort string
		policy, managed, stale       bool
		args                         []string
		refused                      bool
	}{
		{"display without policy", `{"models":{"default":"grok-4.7-build-fast","default_reasoning_effort":"low"}}`, "grok-4.7-build-fast", "low", false, false, false, nil, false},
		{"policy sees overlay", `{"models":{"default":"grok-4.7-build-fast","default_reasoning_effort":"low"}}`, "grok-4.7-build-fast", "low", true, false, false, nil, false},
		{"effort-only overlay", `{"models":{"default_reasoning_effort":"low"}}`, "grok-4.7", "low", true, false, false, nil, false},
		{"model-only overlay", `{"models":{"default":"grok-4.7-build-fast"}}`, "grok-4.7-build-fast", "high", true, false, false, nil, false},
		{"managed wins", `{"models":{"default":"grok-4.7-build-fast","default_reasoning_effort":"low"}}`, "grok-4.7", "high", true, true, false, nil, false},
		{"CLI wins", `{"models":{"default":"grok-4.7-build-fast","default_reasoning_effort":"low"}}`, "grok-4.7", "medium", true, true, false, []string{"--model", "grok-4.6", "--effort", "medium"}, false},
		{"stable runtime snapshot", `{"models":{"default":"grok-4.7-build-fast","default_reasoning_effort":"low"}}`, "grok-4.7-build-fast", "low", true, false, true, nil, false},
		{"custom overlay is not disk fallback", `{"models":{"default":"custom-provider-model","default_reasoning_effort":"low"}}`, "custom-provider-model", "low", true, false, false, nil, true},
		{"other overlay roots are not model settings", `{"model":{"default":"custom-provider-model"},"auth":{"model":"custom-provider-model"}}`, "grok-4.7", "high", true, false, false, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			t.Setenv("HOME", root)
			t.Setenv("GROK_HOME", filepath.Join(root, "native"))
			t.Setenv("GROK_CONFIG", tc.overlay)
			t.Setenv("GROK_CONFIG_PATH", "")
			base := filepath.Join(root, "native")
			if err := os.MkdirAll(base, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(base, "config.toml"), []byte("[models]\ndefault = \"grok-4.5\"\ndefault_reasoning_effort = \"high\"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			high := "high"
			cfg := &config.Config{Engine: config.EngineGrok, EngineOptions: config.EngineOptions{
				ModelPolicy: &config.ModelPolicy{LatestOnly: tc.policy, Replacements: map[string]string{"grok-4.5": "grok-4.7", "grok-4.6": "grok-4.7", "grok-4.7": "grok-4.7", "grok-4.7-build-fast": "grok-4.7-build-fast"}},
				ModelCatalog: &config.ModelCatalog{DefaultModel: "grok-4.7", Models: []config.ModelCatalogEntry{
					{Model: "grok-4.7", Efforts: []string{"low", "medium", "high"}, DefaultEffort: &high},
					{Model: "grok-4.7-build-fast", Efforts: []string{"low", "medium", "high"}, DefaultEffort: &high},
				}},
			}}
			if tc.managed {
				// Engine-specific compatibility overrides take precedence over
				// generic overrides in both runtime and shared policy selection.
				cfg.EngineOptions.ModelOverride = textPointer("grok-4.5")
				cfg.EngineOptions.ReasoningEffortOverride = textPointer("low")
				cfg.EngineOptions.GrokModelOverride = textPointer("grok-4.7")
				cfg.EngineOptions.GrokReasoningEffortOverride = textPointer("high")
			}
			rt, err := native.NewRuntime(base, cfg, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = rt.Close() })
			if err := rt.Configure("/fixture/cxx", cfg, false, tc.args); err != nil {
				t.Fatal(err)
			}
			if tc.stale {
				t.Setenv("GROK_CONFIG", `{"models":{"default":"stale-model","default_reasoning_effort":"xhigh"}}`)
			}
			args, err := applyRuntimeModelPolicy(cfg, tc.args, rt, io.Discard)
			if tc.refused {
				if err == nil || !strings.Contains(err.Error(), `unsupported grok model "custom-provider-model"`) {
					t.Fatalf("custom overlay was not evaluated: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			// This is the exact finalized-runtime input used by main's boot
			// screen, after the same model-policy invocation above.
			in := startupInput{Config: cfg, Home: rt.Home, EffectiveHome: true, Overlay: rt.ModelPreferences(), LaunchArgs: args}
			model, effort, err := startupPreferences(in)
			if err != nil || model != tc.model || effort != tc.effort {
				t.Fatalf("startup model=%s effort=%s err=%v; args=%q", model, effort, err, args)
			}
			if tc.policy && (nativeArgument(args, "--model") != tc.model || nativeArgument(args, "--reasoning-effort") != tc.effort) {
				t.Fatalf("policy arguments ignore runtime selection: %q", args)
			}
		})
	}
}

func TestStartupAndRuntimeUseTheSameMalformedOverlayFallback(t *testing.T) {
	for _, ext := range []string{"json", "toml"} {
		t.Run(ext, func(t *testing.T) {
			in := startupFixture(t)
			in.EffectiveHome = false
			t.Setenv("HOME", t.TempDir())
			t.Setenv("GROK_CONFIG", "malformed inline")
			path := filepath.Join(t.TempDir(), "overlay."+ext)
			body := `{"models":{"default":"grok-4.7-build-fast","default_reasoning_effort":"medium"}}`
			if ext == "toml" {
				body = "[models]\ndefault='grok-4.7-build-fast'\ndefault_reasoning_effort='medium'\n"
			}
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("GROK_CONFIG_PATH", path)
			model, effort, err := startupPreferences(in)
			if err != nil || model != "grok-4.7-build-fast" || effort != "medium" {
				t.Fatalf("status fallback differs from native: %s/%s %v", model, effort, err)
			}
			rt, err := native.NewRuntime(in.Home, in.Config, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = rt.Close() })
			if err := rt.Configure("/fixture/cxx", in.Config, false); err != nil {
				t.Fatal(err)
			}
			// The runtime snapshots the file. Replacing it and process env
			// after Configure must not alter launch or display preferences.
			if err := os.WriteFile(path, []byte("invalid file now"), 0o600); err != nil {
				t.Fatal(err)
			}
			in.Home, in.EffectiveHome, in.Overlay = rt.Home, true, rt.ModelPreferences()
			model, effort, err = startupPreferences(in)
			if err != nil || model != "grok-4.7-build-fast" || effort != "medium" || len(rt.Warnings) != 1 {
				t.Fatalf("runtime snapshot lost: %s/%s %v warnings=%v", model, effort, err, rt.Warnings)
			}
		})
	}
}

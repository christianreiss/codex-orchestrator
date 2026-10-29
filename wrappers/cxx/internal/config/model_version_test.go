package config

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestKnownClaudeNativeModelMinimums(t *testing.T) {
	// code.claude.com/docs/en/model-config, checked 2026-10-28.
	for model, boundary := range map[string][2]string{
		"claude-fable-5-1":  {"2.1.256", "2.1.257"},
		"claude-opus-5-5":   {"2.1.279", "2.1.280"},
		"claude-sonnet-5-5": {"2.1.283", "2.1.284"},
		"claude-haiku-5-5":  {"2.1.292", "2.1.293"},
	} {
		for _, id := range []string{model, model + "[1m]", strings.ToUpper(model) + "[1M]"} {
			for _, old := range []string{"", "unknown", boundary[0]} {
				err := CheckModelVersion(EngineClaude, id, old, nil)
				if err == nil || !strings.Contains(err.Error(), boundary[1]) || !strings.Contains(err.Error(), "clx update") {
					t.Fatalf("%s at %q: %v", id, old, err)
				}
			}
			for _, ok := range []string{boundary[1], boundary[1] + " (Claude Code)", "2.1.312"} {
				if err := CheckModelVersion(EngineClaude, id, ok, nil); err != nil {
					t.Fatalf("%s at %q: %v", id, ok, err)
				}
			}
		}
		// The Claude floor never leaks into another engine's namespace.
		if ModelMinimum(EngineCodex, model, nil) != "" || ModelMinimum(EngineGrok, model, nil) != "" {
			t.Fatalf("%s leaked across engines", model)
		}
	}
	for _, model := range []string{"claude-sonnet-5", "claude-opus-4-8", "sonnet", "opus", "opusplan", "vendor/claude-sonnet-5-5", ""} {
		if minimum := ModelMinimum(EngineClaude, model, nil); minimum != "" {
			t.Fatalf("invented minimum %q for %q", minimum, model)
		}
	}
	if ModelMinimum(EngineClaude, "gpt-6.1-terra", nil) != "" {
		t.Fatal("Terra floor leaked into Claude")
	}
	var signed ModelCatalog
	if err := json.Unmarshal([]byte(`{"models":[{"model":"claude-sonnet-5-5","min_cli_version":"2.1.290"}]}`), &signed); err != nil {
		t.Fatal(err)
	}
	if CheckModelVersion(EngineClaude, "claude-sonnet-5-5[1m]", "2.1.289", &signed) == nil {
		t.Fatal("ignored signed stronger minimum")
	}
}

func TestKnownNativeModelMinimum(t *testing.T) {
	for _, version := range []string{"", "unknown", "0.158.9", "0.159.0-rc1"} {
		if CheckModelVersion(EngineCodex, "gpt-6.1-terra", version, nil) == nil {
			t.Fatalf("accepted %q", version)
		}
	}
	for _, version := range []string{"0.159.0", "codex-cli 0.164.0", "1.0.0", "0.159.0+build"} {
		if err := CheckModelVersion(EngineCodex, "gpt-6.1-terra", version, nil); err != nil {
			t.Fatal(err)
		}
	}
	for _, engine := range []string{EngineCodex, EngineClaude, EngineGrok} {
		if err := CheckModelVersion(engine, "custom-provider", "", nil); err != nil {
			t.Fatal(err)
		}
	}
	var old ModelCatalog
	if err := json.Unmarshal([]byte(`{"default_model":"gpt-6.1-terra","models":[{"model":"gpt-6.1-terra","efforts":["low"],"default_effort":"low"}]}`), &old); err != nil {
		t.Fatal(err)
	}
	if CheckModelVersion(EngineCodex, old.DefaultModel, "0.158.0", &old) == nil {
		t.Fatal("old JSON bypassed known floor")
	}
	var modern ModelCatalog
	if err := json.Unmarshal([]byte(`{"models":[{"model":"gpt-6.1-terra","min_cli_version":"0.160.0"}]}`), &modern); err != nil {
		t.Fatal(err)
	}
	if CheckModelVersion(EngineCodex, "gpt-6.1-terra", "0.159.0", &modern) == nil {
		t.Fatal("ignored signed stronger minimum")
	}
}

func TestSignedMinCLIVersionsReplaceLegacyFloors(t *testing.T) {
	// A catalog carrying min_cli_versions is authoritative, also for models it
	// omitted from Models; the frozen literals apply only to older catalogs.
	signed := &ModelCatalog{MinCLIVersions: map[string]string{"gpt-6.1-terra": "0.160.0", "gpt-7-nova": "0.170.0"}}
	if got := ModelMinimum(EngineCodex, "gpt-6.1-terra", signed); got != "0.160.0" {
		t.Fatalf("signed floor ignored: %q", got)
	}
	if got := ModelMinimum(EngineCodex, " gpt-7-nova ", signed); got != "0.170.0" {
		t.Fatalf("model unknown to the wrapper lost its signed floor: %q", got)
	}
	if err := CheckModelVersion(EngineCodex, "gpt-7-nova", "0.169.9", signed); err == nil || !strings.Contains(err.Error(), "cdx update") {
		t.Fatalf("old CLI accepted: %v", err)
	}
	empty := &ModelCatalog{MinCLIVersions: map[string]string{}}
	if got := ModelMinimum(EngineClaude, "claude-haiku-5-5", empty); got != "" {
		t.Fatalf("legacy floor overrode an authoritative empty map: %q", got)
	}
	// Entry floors still only raise the signed value, and gated entries count.
	raised := &ModelCatalog{MinCLIVersions: map[string]string{"gpt-6.1-luna": "0.165.0"},
		LiveCatalogModels: []ModelCatalogEntry{{Model: "gpt-6.1-luna", MinCLIVersion: "0.166.0"}}}
	if got := ModelMinimum(EngineCodex, "gpt-6.1-luna", raised); got != "0.166.0" {
		t.Fatalf("entry floor ignored: %q", got)
	}
	// Older catalog (no map): the frozen fallback still applies.
	if got := ModelMinimum(EngineCodex, "gpt-6.1-terra", &ModelCatalog{}); got != "0.159.0" {
		t.Fatalf("legacy fallback lost: %q", got)
	}
}

func TestModelCatalogDecodesAdditiveKeys(t *testing.T) {
	var catalog ModelCatalog
	raw := `{"default_model":"gpt-6-astra","models":[],"min_cli_versions":{"gpt-6.1-terra":"0.159.0"},"live_catalog_models":[{"model":"gpt-6.1-luna","efforts":["low"],"session_efforts":[],"default_effort":"low"}]}`
	if err := json.Unmarshal([]byte(raw), &catalog); err != nil {
		t.Fatal(err)
	}
	if catalog.MinCLIVersions["gpt-6.1-terra"] != "0.159.0" || len(catalog.LiveCatalogModels) != 1 || catalog.LiveCatalogModels[0].Model != "gpt-6.1-luna" {
		t.Fatalf("additive keys not decoded: %#v", catalog)
	}
}

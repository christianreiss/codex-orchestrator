package config

import (
	"encoding/json"
	"testing"
)

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

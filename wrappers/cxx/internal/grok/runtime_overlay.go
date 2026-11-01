package grok

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml"
)

// ModelPreferences is the only part of an environment overlay which the
// wrapper needs to inspect. It never supplies authored disk configuration.
type ModelPreferences struct {
	Model, Effort string
}

func modelPreferences(overlay map[string]any) ModelPreferences {
	models, _ := overlay["models"].(map[string]any)
	model, _ := models["default"].(string)
	effort, _ := models["default_reasoning_effort"].(string)
	return ModelPreferences{Model: strings.TrimSpace(model), Effort: strings.TrimSpace(effort)}
}

// ProcessModelPreferences is for status displays before a runtime exists. It
// follows the same native malformed-input fallback as runtime configuration.
func ProcessModelPreferences() ModelPreferences {
	return modelPreferences((&Runtime{}).processOverlay())
}

// ModelPreferences returns the configured runtime's stable overlay selection,
// including explicit fleet overrides. Later changes to process env or an
// overlay file cannot alter the snapshot passed to the native child.
func (r *Runtime) ModelPreferences() ModelPreferences {
	var overlay map[string]any
	_ = json.Unmarshal([]byte(r.overlay), &overlay)
	return modelPreferences(overlay)
}

// processOverlay preserves Grok's inline/file precedence and malformed-input
// fallback. It does not apply an allowlist: the native overlay consumer owns
// that evolving policy, including gates which ignore even allowed features.
// None of the returned values may be promoted into the private disk snapshot.
func (r *Runtime) processOverlay() map[string]any {
	if inline := os.Getenv("GROK_CONFIG"); strings.TrimSpace(inline) != "" {
		var overlay map[string]any
		if json.Unmarshal([]byte(inline), &overlay) == nil && overlay != nil {
			return overlay
		}
		r.Warnings = append(r.Warnings, "Invalid GROK_CONFIG JSON object ignored; trying GROK_CONFIG_PATH.")
	}
	path := os.Getenv("GROK_CONFIG_PATH")
	if strings.TrimSpace(path) == "" {
		return map[string]any{}
	}
	data, err := os.ReadFile(path)
	if err == nil {
		if filepath.Ext(path) == ".json" {
			var overlay map[string]any
			if json.Unmarshal(data, &overlay) == nil && overlay != nil {
				return overlay
			}
		} else if tree, parseErr := toml.LoadBytes(data); parseErr == nil {
			return tree.ToMap()
		}
	}
	// Paths and parser diagnostics may contain confidential user data.
	r.Warnings = append(r.Warnings, "Unavailable or invalid GROK_CONFIG_PATH overlay ignored.")
	return map[string]any{}
}

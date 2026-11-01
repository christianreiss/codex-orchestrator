package grok

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml"
)

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

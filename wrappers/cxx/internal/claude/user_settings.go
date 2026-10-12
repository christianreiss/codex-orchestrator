package claude

import (
	"encoding/json"
	"strings"
)

// UserSettingsPreferences reads native user-scope model preferences. A selected
// launch model chooses its own saved effort without changing the saved model.
// Canonical fleet IDs are used as modelSettings keys; the native [1m] modifier
// does not change the underlying model's preference.
func UserSettingsPreferences(raw []byte, selectedModel string) (model, effort string) {
	var settings struct {
		Model         string `json:"model"`
		EffortLevel   string `json:"effortLevel"`
		ModelSettings map[string]struct {
			EffortLevel string `json:"effortLevel"`
		} `json:"modelSettings"`
	}
	if json.Unmarshal(raw, &settings) != nil {
		return "", ""
	}
	model = strings.TrimSpace(settings.Model)
	selectedModel = strings.TrimSpace(selectedModel)
	if selectedModel == "" {
		selectedModel = model
	}
	selectedModel = strings.TrimSuffix(selectedModel, "[1m]")
	if entry, exists := settings.ModelSettings[selectedModel]; exists {
		if value := strings.TrimSpace(entry.EffortLevel); value != "" {
			return model, value
		}
	}
	// The old user-level effort key stopped applying with Opus 5.5.
	switch selectedModel {
	case "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5":
		return model, ""
	}
	return model, strings.TrimSpace(settings.EffortLevel)
}

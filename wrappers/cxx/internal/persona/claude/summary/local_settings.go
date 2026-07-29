package summary

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

func inheritedClaudeModel() string {
	return strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))
}

// localClaudePreferences reads the effective user-scope model hints that
// Claude Code will consume when neither the wrapper config nor the host API
// supplies an override. Invalid or absent settings are already surfaced by
// `clx doctor`; the at-a-glance screen simply omits unknown values.
func localClaudePreferences() (model, effort string) {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return "", ""
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return "", ""
	}
	var settings struct {
		Model       string `json:"model"`
		EffortLevel string `json:"effortLevel"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		return "", ""
	}
	return strings.TrimSpace(settings.Model), strings.TrimSpace(settings.EffortLevel)
}

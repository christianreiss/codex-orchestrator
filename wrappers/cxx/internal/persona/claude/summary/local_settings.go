package summary

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
)

func inheritedClaudeModel() string {
	return strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))
}

// buildEnv and the runtime auth settings overlay preserve this non-auth
// variable. Native Claude resolves it before session --effort; auto/unset
// remove an explicit effort, while unrecognized values fall through.
func inheritedClaudeEffort() (string, bool) {
	value := strings.ToLower(os.Getenv("CLAUDE_CODE_EFFORT_LEVEL"))
	if value == "auto" || value == "unset" {
		return "", true
	}
	if normalized := claude.NormalizeEffort(value); normalized != "" && value != "ultracode" && value == strings.TrimSpace(value) {
		return normalized, true
	}
	// Native env parsing also accepts integer effort budgets. Keep the value
	// as a budget rather than inventing a corresponding named effort level.
	if budget, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64); err == nil {
		return strconv.FormatInt(budget, 10), true
	}
	return "", false
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

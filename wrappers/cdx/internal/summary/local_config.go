package summary

import (
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
)

// localCodexPreferences reads the effective user-scope defaults consumed by
// Codex when neither signed wrapper config nor host response supplies a field.
// Invalid config is surfaced by doctor; the glanceable card omits unknowns.
func localCodexPreferences() (model, effort string) {
	home, err := codex.CodexHome()
	if err != nil || strings.TrimSpace(home) == "" {
		return "", ""
	}
	tree, err := toml.LoadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		return "", ""
	}
	if value, ok := tree.Get("model").(string); ok {
		model = strings.TrimSpace(value)
	}
	if value, ok := tree.Get("model_reasoning_effort").(string); ok {
		effort = strings.TrimSpace(value)
	}
	return model, effort
}

package codex

import (
	"os"
	"path/filepath"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/skillstore"
)

// SkillEntries owns only the native menu entries installed by the fleet.
// Codex searches this root across CODEX_HOME profiles, so the ownership
// manifest is also per user.
func SkillEntries() (skillstore.Store, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return skillstore.Store{}, err
	}
	return skillstore.Store{
		Root:         filepath.Join(home, ".agents", "skills"),
		ManifestPath: filepath.Join(home, ".config", "codex-orchestrator", "codex-skills.json"),
		Label:        "Codex",
	}, nil
}

func StripSkillEntries() error {
	store, err := SkillEntries()
	if err != nil {
		return err
	}
	return store.Strip()
}

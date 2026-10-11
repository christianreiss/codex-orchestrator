package lifecycle

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// Keep an observed fleet refusal independently of the signed config, which only
// background maintenance may refresh. An API outage cannot erase this evidence.
func suspensionObservationPath(cfg *config.Config) (string, error) {
	if cfg == nil || cfg.Orchestrator.BaseURL == "" || cfg.Orchestrator.APIKey == "" {
		return "", nil
	}
	home, err := codex.CodexHome()
	if err != nil {
		return "", err
	}
	identity := sha256.Sum256([]byte(strings.TrimRight(cfg.Orchestrator.BaseURL, "/") + "\x00" + cfg.Orchestrator.APIKey))
	return filepath.Join(home, fmt.Sprintf(".cxx-suspension-%x", identity[:16])), nil
}

func recordSuspensionObservation(cfg *config.Config, auth *orchestrator.AuthRetrieveResponse) error {
	if auth == nil {
		return nil
	}
	suspended := auth.Status == orchestrator.AuthStatusSuspended
	if !suspended && !serverAnsweredForEngine(auth) {
		return nil
	}
	path, err := suspensionObservationPath(cfg)
	if err != nil || path == "" {
		return err
	}
	if suspended {
		return atomicWrite(path, []byte("codex suspended fleet-wide\n"), 0o600)
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func observedSuspension(cfg *config.Config) (bool, error) {
	path, err := suspensionObservationPath(cfg)
	if err != nil || path == "" {
		return false, err
	}
	_, err = os.Stat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	return err == nil, err
}

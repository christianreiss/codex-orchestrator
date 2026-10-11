package agentbus

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
	"github.com/google/uuid"
)

var errNativeTranscriptMissing = errors.New("native transcript missing; fresh start requires operator approval")

// Grok's generic "Couldn't start session" also covers non-storage failures.
// Establish absence from its durable session tree, never from that error alone.
func checkGrokTranscript(id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return fmt.Errorf("invalid native session UUID: %w", err)
	}
	root, err := sessionguard.Root("grok")
	if err != nil {
		return err
	}
	root = filepath.Join(root, "sessions")
	projects, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return errNativeTranscriptMissing
	}
	if err != nil {
		return err
	}
	for _, project := range projects {
		if !project.IsDir() {
			continue
		}
		path := filepath.Join(root, project.Name(), id, "summary.json")
		state, err := os.Stat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if !state.Mode().IsRegular() || state.Size() == 0 {
			return errors.New("native session summary is not a nonempty regular file")
		}
		return nil
	}
	return errNativeTranscriptMissing
}

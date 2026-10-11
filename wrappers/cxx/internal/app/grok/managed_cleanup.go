package grok

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/memoryrouting"
	"os"
	"path/filepath"
	"strings"
)

// Strip only recorded fleet ownership; preserve authored/user-edited content.
func stripManagedContent(home string) error {
	_, result := memoryrouting.Apply("grok", home, &memoryrouting.Bundle{Enabled: false}, nil)
	store, err := native.Skills()
	if err == nil {
		err = store.Strip()
	}
	result = errors.Join(result, err)
	result = errors.Join(result, native.SyncConfig(home, nil, []string{}))
	state, err := native.StateDir()
	if err != nil {
		return errors.Join(result, err)
	}
	digest, err := os.ReadFile(filepath.Join(state, "managed-agents.sha256"))
	if err == nil {
		body, readErr := os.ReadFile(filepath.Join(home, "AGENTS.md"))
		if readErr == nil {
			sum := sha256.Sum256(body)
			if strings.TrimSpace(string(digest)) == hex.EncodeToString(sum[:]) {
				result = errors.Join(result, os.Remove(filepath.Join(home, "AGENTS.md")))
			}
		}
		if readErr != nil && !os.IsNotExist(readErr) {
			result = errors.Join(result, readErr)
		}
		result = errors.Join(result, os.Remove(filepath.Join(state, "managed-agents.sha256")))
	} else if !os.IsNotExist(err) {
		result = errors.Join(result, err)
	}
	return result
}

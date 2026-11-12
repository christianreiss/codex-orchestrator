package kimi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

// Sessions are linked directly. The root catalog uses atomic rename in Kimi,
// which would replace a symlink, so merge its private snapshot at native exit.
// The cleaner runs this even when the launcher died before the native child.
type durableCatalog struct {
	Home     string `json:"home"`
	Original string `json:"original"`
}

const durableCatalogFile = ".cxx-durable-catalog.json"

func catalogDigest(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
func prepareDurableCatalog(dir, base string) error {
	raw, err := os.ReadFile(filepath.Join(base, "projects.json"))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	value, _ := json.Marshal(durableCatalog{Home: base, Original: catalogDigest(raw)})
	if err := AtomicWrite(filepath.Join(dir, durableCatalogFile), value, 0600); err != nil {
		return err
	}
	index := filepath.Join(base, "session_index.jsonl")
	f, err := os.OpenFile(index, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Symlink(index, filepath.Join(dir, "home", "session_index.jsonl"))
}
func persistDurableCatalog(dir string) error {
	raw, err := os.ReadFile(filepath.Join(dir, durableCatalogFile))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var meta durableCatalog
	if json.Unmarshal(raw, &meta) != nil || !filepath.IsAbs(meta.Home) || meta.Home == dir {
		return errors.New("invalid Kimi durable catalog metadata")
	}
	local, err := os.ReadFile(filepath.Join(dir, "home", "projects.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if catalogDigest(local) == meta.Original {
		return nil
	}
	var incoming map[string]any
	if json.Unmarshal(local, &incoming) != nil || incoming["schema_version"] != float64(2) {
		return errors.New("invalid private Kimi projects catalog")
	}
	guard, err := ipc.TryAcquireExclusivePath(filepath.Join(meta.Home, ".ckx-catalog.lock"))
	if err != nil {
		return err
	}
	defer guard.Release()
	target := filepath.Join(meta.Home, "projects.json")
	existing, err := os.ReadFile(target)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	merged := map[string]any{}
	if len(existing) > 0 && (json.Unmarshal(existing, &merged) != nil || merged["schema_version"] != float64(2)) {
		return errors.New("invalid durable Kimi projects catalog")
	}
	for key, value := range incoming {
		if _, ok := merged[key]; !ok {
			merged[key] = value
		}
	}
	for _, key := range []string{"projects", "idempotency_keys"} {
		dst, _ := merged[key].(map[string]any)
		if dst == nil {
			dst = map[string]any{}
		}
		src, _ := incoming[key].(map[string]any)
		for id, value := range src {
			// A concurrently finished session may already have a newer visit.
			old, _ := dst[id].(map[string]any)
			next, _ := value.(map[string]any)
			oldTime, _ := old["last_opened_at"].(string)
			nextTime, _ := next["last_opened_at"].(string)
			if oldTime == "" || nextTime >= oldTime {
				dst[id] = value
			}
		}
		merged[key] = dst
	}
	deleted := map[string]bool{}
	for _, obj := range []map[string]any{merged, incoming} {
		if ids, ok := obj["deleted_project_ids"].([]any); ok {
			for _, id := range ids {
				if s, ok := id.(string); ok {
					deleted[s] = true
				}
			}
		}
	}
	ids := []string{}
	projects, _ := merged["projects"].(map[string]any)
	for id := range deleted {
		ids = append(ids, id)
		delete(projects, id)
	}
	merged["deleted_project_ids"] = ids
	value, err := json.Marshal(merged)
	if err != nil {
		return err
	}
	return AtomicWrite(target, value, 0600)
}

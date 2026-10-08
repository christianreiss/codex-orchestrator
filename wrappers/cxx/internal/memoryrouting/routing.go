// Package memoryrouting maintains short MCP reminders at native memory entrypoints.
// It never imports or exports memory facts and owns only its marked blocks.
package memoryrouting

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

const Start = "<!-- cxx:memory-routing:start -->"
const End = "<!-- cxx:memory-routing:end -->"
const manifestName = ".cxx-memory-routing.json"
const topicName = "cxx-memory-routing.md"

// Bundle is optional: nil means an older server and must leave files alone.
type Bundle struct {
	Enabled bool   `json:"enabled"`
	Content string `json:"content"`
}

// TrustLost distinguishes explicit host revocation from an outage or suspension.
func TrustLost(code string) bool {
	switch strings.ToLower(strings.TrimSpace(code)) {
	case "invalid_api_key", "host_disabled", "host_deleted", "insecure_denied":
		return true
	default:
		return false
	}
}

// Apply converges reminders, including previously owned custom locations.
// home is the engine's effective native home (before Grok runtime projection).
func Apply(engine, home string, bundle *Bundle, args []string) (bool, error) {
	if bundle == nil {
		return false, nil
	}
	if bundle.Enabled && (strings.TrimSpace(bundle.Content) == "" || strings.Contains(bundle.Content, Start) || strings.Contains(bundle.Content, End)) {
		return false, errors.New("invalid memory routing content")
	}
	home, err := filepath.Abs(home)
	if err != nil {
		return false, err
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(home, ".cxx-memory-routing.lock"))
	if err != nil {
		return false, err
	}
	defer lock.Release()
	paths, err := targets(engine, home, bundle.Enabled, args)
	if err != nil {
		return false, err
	}
	manifest := filepath.Join(home, manifestName)
	raw, err := readRegular(manifest)
	if err != nil {
		return false, err
	}
	var old []string
	if len(raw) > 0 && json.Unmarshal(raw, &old) != nil {
		return false, errors.New("invalid memory routing ownership manifest")
	}
	all := make(map[string]bool)
	for _, path := range paths {
		all[path] = bundle.Enabled
	}
	for _, path := range old {
		if !filepath.IsAbs(path) || (filepath.Base(path) != "MEMORY.md" && filepath.Base(path) != "memory_summary.md" && filepath.Base(path) != topicName) {
			return false, errors.New("invalid memory routing ownership path")
		}
		if _, ok := all[path]; !ok {
			all[path] = false
		}
	}
	if len(all) == 0 {
		return false, nil
	}
	ordered := make([]string, 0, len(all))
	for path := range all {
		ordered = append(ordered, path)
	}
	sort.Strings(ordered)
	// Persist every cleanup target before touching files so failures can be retried.
	tracked, _ := json.Marshal(ordered)
	if !bytes.Equal(raw, tracked) {
		if err := replaceRegular(manifest, raw, tracked); err != nil {
			return false, err
		}
	}
	changed := false
	var applyErr error
	for _, path := range ordered {
		updated, err := applyFile(path, bundle.Content, all[path])
		changed = changed || updated
		if err != nil {
			applyErr = errors.Join(applyErr, fmt.Errorf("memory routing %s: %w", path, err))
		}
	}
	if applyErr != nil {
		return changed, applyErr
	}
	current := []string{}
	if bundle.Enabled {
		current = paths
	}
	next, _ := json.Marshal(current)
	if !bytes.Equal(tracked, next) {
		if err := replaceRegular(manifest, tracked, next); err != nil {
			return changed, err
		}
	}
	return changed, nil
}

// strip removes only the block and the two newlines written with it.
func strip(body []byte) ([]byte, error) {
	for {
		begin := bytes.Index(body, []byte(Start))
		if begin < 0 {
			if bytes.Contains(body, []byte(End)) {
				return nil, errors.New("unpaired memory routing marker")
			}
			return body, nil
		}
		tail := body[begin+len(Start):]
		finish := bytes.Index(tail, []byte(End))
		if finish < 0 || bytes.Contains(tail[:finish], []byte(Start)) {
			return nil, errors.New("incomplete memory routing block")
		}
		end := begin + len(Start) + finish + len(End)
		for n := 0; n < 2 && end < len(body) && body[end] == '\n'; n++ {
			end++
		}
		body = append(append([]byte{}, body[:begin]...), body[end:]...)
	}
}

func applyFile(path, content string, enabled bool) (bool, error) {
	before, err := readRegular(path)
	if err != nil {
		return false, err
	}
	after, err := strip(before)
	if err != nil {
		return false, err
	}
	if enabled {
		after = append([]byte(Start+"\n"+strings.TrimSpace(content)+"\n"+End+"\n\n"), after...)
	}
	if bytes.Equal(before, after) {
		return false, nil
	}
	if err := replaceRegular(path, before, after); err != nil {
		return false, err
	}
	// Only a dedicated topic is removed when no user content remains.
	if !enabled && filepath.Base(path) == topicName && len(after) == 0 {
		latest, err := readRegular(path)
		if err != nil {
			return true, err
		}
		if !bytes.Equal(latest, after) {
			return true, errors.New("memory changed during cleanup; retry sync")
		}
		return true, os.Remove(path)
	}
	return true, nil
}

func readRegular(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("memory target is not a regular file")
	}
	return os.ReadFile(path)
}

// Re-read immediately before rename: native memory writers do not take our lock.
// A detected change is retryable and never replaced with a stale snapshot.
func replaceRegular(path string, before, after []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if info, err := os.Lstat(path); err == nil {
		mode = info.Mode().Perm()
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".cxx-memory-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(mode); err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.Write(after); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	latest, err := readRegular(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(latest, before) {
		return errors.New("memory changed during sync; retry sync")
	}
	return os.Rename(f.Name(), path)
}

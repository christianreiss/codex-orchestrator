package grok

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml"
)

type configOwnership struct {
	Version int               `json:"version"`
	Paths   map[string]string `json:"paths"`
}

func configPathParts(path string) []string {
	if strings.HasPrefix(path, "mcp_servers.") {
		return []string{"mcp_servers", strings.TrimPrefix(path, "mcp_servers.")}
	}
	return strings.Split(path, ".")
}
func configGet(root map[string]any, parts []string) (any, bool) {
	if len(parts) == 0 {
		return nil, false
	}
	var value any = root
	for _, part := range parts {
		m, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		value, ok = m[part]
		if !ok {
			return nil, false
		}
	}
	return value, true
}
func configDelete(root map[string]any, parts []string) {
	if len(parts) == 1 {
		delete(root, parts[0])
		return
	}
	child, ok := root[parts[0]].(map[string]any)
	if !ok {
		return
	}
	configDelete(child, parts[1:])
	if len(child) == 0 {
		delete(root, parts[0])
	}
}
func configValueDigest(value any) string {
	raw, _ := json.Marshal(value)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// SyncConfig applies the fleet TOML partial and prunes ceased-owned settings.
// The sidecar contains only hashes, never copies of MCP headers or credentials.
func SyncConfig(home string, body []byte, owned []string) error {
	managed, err := toml.LoadBytes(body)
	if err != nil {
		return errors.New("invalid managed Grok TOML")
	}
	partial := managed.ToMap()
	merged := map[string]any{}
	path := filepath.Join(home, "config.toml")
	if raw, err := os.ReadFile(path); err == nil {
		tree, err := toml.LoadBytes(raw)
		if err != nil {
			return errors.New("invalid existing Grok TOML")
		}
		merged = tree.ToMap()
	} else if !os.IsNotExist(err) {
		return err
	}
	state, err := StateDir()
	if err != nil {
		return err
	}
	manifest := filepath.Join(state, "managed-keys.json")
	previous := configOwnership{}
	if raw, err := os.ReadFile(manifest); err == nil {
		if json.Unmarshal(raw, &previous) != nil || previous.Version != 1 {
			return errors.New("invalid Grok managed ownership manifest")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if owned == nil {
		// Older third-engine servers lack the explicit metadata. Infer only the
		// known managed native tables, never user hook or permission ownership.
		if models, ok := partial["models"].(map[string]any); ok {
			for _, key := range []string{"default", "default_reasoning_effort"} {
				if _, exists := models[key]; exists {
					owned = append(owned, "models."+key)
				}
			}
		}
		if servers, ok := partial["mcp_servers"].(map[string]any); ok {
			for name := range servers {
				owned = append(owned, "mcp_servers."+name)
			}
		}
	}
	next := configOwnership{Version: 1, Paths: map[string]string{}}
	for _, path := range owned {
		parts := configPathParts(path)
		for _, part := range parts {
			if part == "" || strings.ContainsAny(part, "\x00\r\n") {
				return errors.New("invalid Grok config owned path")
			}
		}
		if value, present := configGet(partial, parts); present {
			next.Paths[path] = configValueDigest(value)
		}
	}
	for path, digest := range previous.Paths {
		if _, kept := next.Paths[path]; kept {
			continue
		}
		parts := configPathParts(path)
		if value, present := configGet(merged, parts); present && configValueDigest(value) == digest {
			configDelete(merged, parts)
		}
	}
	// An owned MCP entry is a complete native server definition. Replacing its
	// transport must remove the old command/url/headers together, otherwise a
	// recursive merge leaves an invalid mixed transport or retired credentials.
	for path := range next.Paths {
		if strings.HasPrefix(path, "mcp_servers.") {
			configDelete(merged, configPathParts(path))
		}
	}
	mergeMap(merged, partial)
	tree, err := toml.TreeFromMap(merged)
	if err != nil {
		return err
	}
	text, err := tree.ToTomlString()
	if err != nil {
		return err
	}
	if err := AtomicWrite(path, []byte(text), 0o600); err != nil {
		return err
	}
	raw, err := json.Marshal(next)
	if err != nil {
		return err
	}
	return AtomicWrite(manifest, raw, 0o600)
}

package codex

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// AuthPath returns ~/.codex/auth.json (the upstream CLI's expected location).
func AuthPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".codex", "auth.json"), nil
}

// LocalDigest returns the SHA256 of the current local auth.json, or empty if absent.
func LocalDigest() (string, error) {
	p, err := AuthPath()
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// WriteAuth materializes a new auth.json from the orchestrator response,
// atomically replacing any existing file. payload is the raw JSON body the
// server returns under the `auth` key.
func WriteAuth(payload json.RawMessage) error {
	if len(payload) == 0 {
		return errors.New("empty auth payload")
	}
	// Ensure it's valid JSON before persisting.
	var probe any
	if err := json.Unmarshal(payload, &probe); err != nil {
		return fmt.Errorf("auth payload not valid JSON: %w", err)
	}

	p, err := AuthPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	tmp := p + ".new"
	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

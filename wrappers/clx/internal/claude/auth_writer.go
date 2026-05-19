package claude

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// AuthPath returns ~/.claude/.credentials.json — the upstream CLI's location.
func AuthPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", ".credentials.json"), nil
}

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

// ReadAuth returns the raw bytes of the local credentials.json.
func ReadAuth() (json.RawMessage, error) {
	p, err := AuthPath()
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

func WriteAuth(payload json.RawMessage) error {
	if len(payload) == 0 {
		return errors.New("empty auth payload")
	}
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

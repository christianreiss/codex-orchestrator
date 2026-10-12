package launchpad

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// StatePath is where the last selection is remembered. It is a per-user
// convenience: losing it only moves the cursor back to the configured default.
func StatePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cxx", "launchpad.json"), nil
}

// LoadLast reads the remembered selection; any failure means "none".
func LoadLast(path string) *Selection {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var s Selection
	if json.Unmarshal(raw, &s) != nil || s.Engine == "" {
		return nil
	}
	return &s
}

// SaveLast remembers a selection atomically. The mode is not remembered:
// "continue" is a one-off, the next start should default to a new chat.
func SaveLast(path string, s Selection) error {
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".launchpad-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

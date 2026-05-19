package codex

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
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

// ReadAuth returns the raw bytes of the local auth.json (or error if missing).
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

// BackfillLastRefresh returns raw with `last_refresh` set to the current UTC
// RFC3339 timestamp when the field is absent or empty — matching the legacy
// bash `normalize_auth_json_file` behaviour that lets a plain `codex login`
// auth.json reach /auth store without bouncing on the server's RFC3339
// validation. Returns (out, modified, error). On invalid JSON or empty input
// the original bytes pass through unchanged so the server can reject them
// authoritatively.
func BackfillLastRefresh(raw []byte) (json.RawMessage, bool, error) {
	if len(raw) == 0 {
		return json.RawMessage(raw), false, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return json.RawMessage(raw), false, nil
	}
	if cur, ok := obj["last_refresh"]; ok {
		var s string
		if err := json.Unmarshal(cur, &s); err == nil && strings.TrimSpace(s) != "" {
			return json.RawMessage(raw), false, nil
		}
	}
	stamp, _ := json.Marshal(time.Now().UTC().Format(time.RFC3339))
	obj["last_refresh"] = stamp
	out, err := json.Marshal(obj)
	if err != nil {
		return json.RawMessage(raw), false, err
	}
	return json.RawMessage(out), true, nil
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

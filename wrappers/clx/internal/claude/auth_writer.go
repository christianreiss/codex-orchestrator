package claude

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"time"
)

// AuthPath returns the local credential file path.
//
// Dual-location selection:
//  1. choose the newest structurally usable file across ~/.claude and ~/.clx;
//  2. prefer ~/.claude on ties because upstream Claude Code writes there;
//  3. fall back to ~/.claude when neither exists yet.
func AuthPath() (string, error) {
	path, _, _, err := selectedAuthFile()
	if errors.Is(err, os.ErrNotExist) {
		return path, nil
	}
	return path, err
}

func authPaths() (claudePath, clxPath string, err error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	return filepath.Join(home, ".claude", ".credentials.json"), filepath.Join(home, ".clx", "auth", "credentials.json"), nil
}

// AuthCandidatePaths returns both credential paths in preference order for scans.
func AuthCandidatePaths() ([]string, error) {
	claudePath, clxPath, err := authPaths()
	if err != nil {
		return nil, err
	}
	return []string{claudePath, clxPath}, nil
}

func LocalDigest() (string, error) {
	_, raw, _, err := selectedAuthFile()
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
	_, raw, _, err := selectedAuthFile()
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// ReadAuthForUpload returns a server-store-ready copy of the selected
// credentials. It backfills last_refresh in memory only; local files are changed
// only after the server accepts and returns canonical auth.
func ReadAuthForUpload() (json.RawMessage, string, error) {
	path, raw, _, err := selectedAuthFile()
	if err != nil {
		return nil, "", err
	}
	out, err := backfillLastRefresh(json.RawMessage(raw))
	if err != nil {
		return nil, "", err
	}
	return out, path, nil
}

func ReadAuthForUploadFromPath(path string) (json.RawMessage, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return backfillLastRefresh(json.RawMessage(raw))
}

func WriteAuth(payload json.RawMessage) error {
	if len(payload) == 0 {
		return errors.New("empty auth payload")
	}
	// Claude Code reads ~/.claude/.credentials.json and expects ONLY the
	// claudeAiOauth block. The orchestrator payload may also carry legacy
	// `last_refresh` / `auths` fields. Strip them so Claude does not fall
	// back to the legacy auth flow or show the login wizard.
	toWrite, err := extractClaudeFormat(payload)
	if err != nil {
		return fmt.Errorf("auth payload not valid JSON: %w", err)
	}
	claudePath, clxPath, err := authPaths()
	if err != nil {
		return err
	}
	if err := atomicWrite(claudePath, toWrite); err != nil {
		return err
	}
	if _, statErr := os.Stat(clxPath); statErr == nil {
		if err := atomicWrite(clxPath, toWrite); err != nil {
			return err
		}
	}
	return nil
}

// AuthMatchesCanonical compares the on-disk Claude credential shape with the
// shape WriteAuth would materialize from a fleet payload. Fleet OAuth payloads
// carry last_refresh, while Claude Code's native file must not; comparing raw
// digests would therefore report a permanent false mismatch after every sync.
func AuthMatchesCanonical(path string, payload json.RawMessage) bool {
	local, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	normalized, err := extractClaudeFormat(payload)
	if err != nil {
		return false
	}
	var localDoc, canonicalDoc any
	if err := json.Unmarshal(local, &localDoc); err != nil {
		return false
	}
	if err := json.Unmarshal(normalized, &canonicalDoc); err != nil {
		return false
	}
	return reflect.DeepEqual(localDoc, canonicalDoc)
}

// extractClaudeFormat returns a credentials JSON that Claude Code accepts.
// When the payload contains a claudeAiOauth block it returns just that block;
// otherwise it returns the original payload unchanged (API-key-only setups).
func extractClaudeFormat(payload json.RawMessage) (json.RawMessage, error) {
	var raw struct {
		ClaudeAIOauth json.RawMessage `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, err
	}
	if len(raw.ClaudeAIOauth) == 0 {
		return payload, nil
	}
	out, err := json.Marshal(map[string]json.RawMessage{"claudeAiOauth": raw.ClaudeAIOauth})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// HasUsableAuth reports whether a structurally usable local credentials file
// exists (either location, containing at least one Claude token).
func HasUsableAuth() bool {
	_, raw, _, err := selectedAuthFile()
	return err == nil && isUsableAuth(raw)
}

func selectedAuthFile() (string, []byte, os.FileInfo, error) {
	claudePath, clxPath, err := authPaths()
	if err != nil {
		return "", nil, nil, err
	}
	type cand struct {
		path   string
		raw    []byte
		info   os.FileInfo
		usable bool
	}
	var found []cand
	var lastErr error
	for _, path := range []string{claudePath, clxPath} {
		raw, readErr := os.ReadFile(path)
		if errors.Is(readErr, os.ErrNotExist) {
			continue
		}
		if readErr != nil {
			// A transient/permission error on one candidate should not abort
			// selection when the other candidate may still be usable; skip it.
			lastErr = readErr
			continue
		}
		info, statErr := os.Stat(path)
		if statErr != nil {
			lastErr = statErr
			continue
		}
		found = append(found, cand{path: path, raw: raw, info: info, usable: isUsableAuth(raw)})
	}
	if len(found) == 0 {
		if lastErr != nil {
			return "", nil, nil, lastErr
		}
		return claudePath, nil, nil, os.ErrNotExist
	}
	best := found[0]
	for _, cur := range found[1:] {
		if cur.usable != best.usable {
			if cur.usable {
				best = cur
			}
			continue
		}
		if cur.info.ModTime().After(best.info.ModTime()) ||
			(cur.info.ModTime().Equal(best.info.ModTime()) && cur.path == claudePath) {
			best = cur
		}
	}
	return best.path, best.raw, best.info, nil
}

func isUsableAuth(raw []byte) bool {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return false
	}
	return hasAnyClaudeToken(doc)
}

func backfillLastRefresh(payload json.RawMessage) (json.RawMessage, error) {
	var obj map[string]any
	if err := json.Unmarshal(payload, &obj); err != nil {
		return nil, err
	}
	if cur, ok := obj["last_refresh"].(string); ok && strings.TrimSpace(cur) != "" {
		return payload, nil
	}
	obj["last_refresh"] = time.Now().UTC().Format(time.RFC3339)
	out, err := json.Marshal(obj)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(out), nil
}

// atomicWrite writes body to path via a unique temp file in the same
// directory, forced to 0600, then renames it into place. An advisory
// exclusive file lock serializes concurrent writers (e.g. a refresh cron and
// an interactive session) so they cannot race on the same temp inode or
// interleave writes.
func atomicWrite(path string, body []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	unlock, err := lockAuthPath(path)
	if err != nil {
		return err
	}
	defer unlock()

	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".*.new")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once renamed into place
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	// os.WriteFile/os.CreateTemp only apply the requested mode when creating
	// the file; force 0600 explicitly regardless of umask or pre-existing state.
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

// lockAuthPath takes a blocking, exclusive advisory lock on a sibling lock
// file so concurrent WriteAuth callers serialize instead of racing.
func lockAuthPath(path string) (func(), error) {
	lockPath := path + ".lock"
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		_ = f.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

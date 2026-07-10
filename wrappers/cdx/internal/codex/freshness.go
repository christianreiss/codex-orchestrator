// Package codex - local auth.json freshness + structural validity helpers.
//
// Legacy bash equivalents lived at fe70ac3:bin/cdx.d/02-auth-20-validate.sh
// (validate_auth_json_file, is_last_refresh_recent, get_auth_last_refresh).
//
// Two windows from the legacy interface:
//   - MAX_LOCAL_AUTH_AGE_SECONDS   = 24h  ("fresh", any host)
//   - MAX_LOCAL_AUTH_RECENT_SECONDS =  7d  ("recent", secure hosts only)
//
// Future-skew tolerance mirrors legacy bash: timestamps up to 5 minutes in
// the future are accepted (NTP drift between server and host).
package codex

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"
)

// Standard freshness windows. Exported so callers can compose host-specific
// rules (secure hosts allow MaxAge7d; everything else uses MaxAge24h).
const (
	MaxAge24h        = 24 * time.Hour
	MaxAge7d         = 7 * 24 * time.Hour
	maxFutureSkew    = 5 * time.Minute
	maxFutureSkewStr = "5m"
)

// ErrNoAuthFile is returned by helpers when the local auth file is absent.
var ErrNoAuthFile = errors.New("auth.json not present")

// IsFresh reports whether the local auth.json's last_refresh timestamp is
// within `window` of now (with a 5-minute future-skew tolerance). Missing
// file → (false, ErrNoAuthFile). Unparseable timestamp → (false, error).
func IsFresh(path string, window time.Duration) (bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, ErrNoAuthFile
	}
	if err != nil {
		return false, err
	}
	ts, err := lastRefreshFrom(raw)
	if err != nil {
		return false, err
	}
	now := time.Now().UTC()
	delta := now.Sub(ts)
	if delta < -maxFutureSkew {
		return false, nil
	}
	return delta <= window, nil
}

// IsValidLocalAuth reports whether the file at path looks structurally usable
// to upstream codex. Descends from legacy bash `validate_auth_json_file`, with
// one deliberate relaxation: `last_refresh` is NOT required. Upstream codex
// only needs tokens — the stamp is an orchestrator-ism that vanilla
// `codex login` files never carry, and requiring it made a freshly-minted
// login count as "invalid" (blocking concurrent runs and failed-verification
// fallback right after the user re-authenticated).
//
//   - Parseable JSON object.
//   - Either a non-empty `auths` map with per-entry tokens, OR a fallback
//     token under `tokens.access_token`/`OPENAI_API_KEY`.
func IsValidLocalAuth(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return false
	}
	if auths, ok := doc["auths"].(map[string]any); ok && len(auths) > 0 {
		// Each auth entry must have a non-empty token string.
		for _, v := range auths {
			entry, ok := v.(map[string]any)
			if !ok {
				return false
			}
			tok, _ := entry["token"].(string)
			if strings.TrimSpace(tok) == "" {
				return false
			}
		}
		return true
	}
	if tokens, ok := doc["tokens"].(map[string]any); ok {
		if at, _ := tokens["access_token"].(string); strings.TrimSpace(at) != "" {
			return true
		}
	}
	if k, _ := doc["OPENAI_API_KEY"].(string); strings.TrimSpace(k) != "" {
		return true
	}
	return false
}

// LastRefreshFromRaw parses the last_refresh stamp out of raw auth.json
// bytes. Errors when the field is absent, empty, or unparseable.
func LastRefreshFromRaw(raw []byte) (time.Time, error) {
	return lastRefreshFrom(raw)
}

// LastRefreshOfFile returns the effective freshness time of the auth file at
// path: its last_refresh stamp when present, else the file's mtime. The mtime
// fallback matters because a vanilla `codex login` writes auth.json WITHOUT
// last_refresh — only orchestrator-written canonical blobs carry the stamp —
// and a fresh login must still compare newer than a stale fleet canonical.
func LastRefreshOfFile(path string) (time.Time, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return time.Time{}, ErrNoAuthFile
	}
	if err != nil {
		return time.Time{}, err
	}
	if ts, perr := lastRefreshFrom(raw); perr == nil {
		return ts, nil
	}
	st, err := os.Stat(path)
	if err != nil {
		return time.Time{}, err
	}
	return st.ModTime().UTC(), nil
}

// lastRefreshFrom parses a value from arbitrary auth JSON. Tolerates the `Z`
// suffix (treated as +00:00) and microsecond precision. ISO-8601 only.
func lastRefreshFrom(raw []byte) (time.Time, error) {
	var doc struct {
		LastRefresh string `json:"last_refresh"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return time.Time{}, err
	}
	ts := strings.TrimSpace(doc.LastRefresh)
	if ts == "" {
		return time.Time{}, errors.New("auth.json: missing last_refresh")
	}
	return parseISO8601(ts)
}

// parseISO8601 accepts the timestamp shapes the legacy python wrapper accepts.
func parseISO8601(s string) (time.Time, error) {
	// Normalize trailing Z to +00:00 so RFC3339Nano can swallow it.
	norm := s
	if strings.HasSuffix(norm, "Z") {
		norm = strings.TrimSuffix(norm, "Z") + "+00:00"
	}
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999999-07:00",
		"2006-01-02T15:04:05.999999999-07:00",
	}
	var lastErr error
	for _, l := range layouts {
		if t, err := time.Parse(l, norm); err == nil {
			return t.UTC(), nil
		} else {
			lastErr = err
		}
	}
	return time.Time{}, lastErr
}

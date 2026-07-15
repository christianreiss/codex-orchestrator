// Package claude - local credentials.json freshness + structural validity
// helpers.
//
// Mirrors the cdx engine's codex/freshness.go for the Claude engine. Local
// auth lives at ~/.claude/.credentials.json by default. Same window contract
// (24h general, 7d secure-host stretch) and same ±5min future-skew tolerance.
package claude

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"
)

const (
	MaxAge24h     = 24 * time.Hour
	MaxAge7d      = 7 * 24 * time.Hour
	maxFutureSkew = 5 * time.Minute
)

// ErrNoAuthFile is returned by helpers when the credentials file is absent.
var ErrNoAuthFile = errors.New("credentials.json not present")

// IsFresh reports whether the local credentials.json `last_refresh` is within
// `window` of now (with ±5min future-skew tolerance). Tolerates either
// `last_refresh` or — for the claude-CLI-only path — `claudeAiOauth.expiresAt`
// as a fallback freshness signal.
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
		// Fleet-written and claude-CLI-written OAuth credentials carry only a
		// `claudeAiOauth` block with no `last_refresh` (WriteAuth strips it). Fall
		// back to the OAuth token's own expiry: an access token that has not yet
		// expired is directly usable for an offline launch. This is the fallback
		// the package doc promises and the reason OAuth hosts must not be refused
		// a launch during a brief orchestrator outage.
		if exp, ok := oauthExpiry(raw); ok {
			return time.Now().UTC().Before(exp), nil
		}
		return false, err
	}
	now := time.Now().UTC()
	delta := now.Sub(ts)
	if delta < -maxFutureSkew {
		return false, nil
	}
	return delta <= window, nil
}

// oauthExpiry extracts claudeAiOauth.expiresAt (Unix epoch milliseconds, as
// written by Claude Code) as a UTC time. Returns ok=false when absent or
// non-positive.
func oauthExpiry(raw []byte) (time.Time, bool) {
	var doc struct {
		ClaudeAIOauth struct {
			ExpiresAt int64 `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return time.Time{}, false
	}
	if doc.ClaudeAIOauth.ExpiresAt <= 0 {
		return time.Time{}, false
	}
	return time.UnixMilli(doc.ClaudeAIOauth.ExpiresAt).UTC(), true
}

// IsValidLocalAuth reports whether the file at path looks structurally usable.
// For Claude credentials we accept any of:
//
//   - `api_key` / `anthropic_api_key` (Anthropic API workflow)
//   - `claudeAiOauth.accessToken` (Claude.ai OAuth workflow)
//   - `auths["api.anthropic.com"].token`
//
// Plus a parseable `last_refresh` timestamp (added by /sync or `clx auth-upload`).
func IsValidLocalAuth(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return false
	}
	lr, _ := doc["last_refresh"].(string)
	if strings.TrimSpace(lr) == "" {
		// Pure claude-CLI files may carry only an OAuth block; allow that
		// path because the legacy bash mirror accepted it.
		return hasAnyClaudeToken(doc)
	}
	if hasAnyClaudeToken(doc) {
		return true
	}
	return false
}

// LastRefreshFromRaw parses the fleet freshness stamp from canonical
// credentials. It intentionally does not fall back to OAuth expiry: this is a
// replacement-order comparison, not a launch-validity check.
func LastRefreshFromRaw(raw []byte) (time.Time, error) {
	return lastRefreshFrom(raw)
}

// LastRefreshOfFile returns last_refresh when present and otherwise the file's
// mtime. Native Claude logins omit last_refresh, so mtime protects a fresh local
// login from being overwritten by an older fleet copy.
func LastRefreshOfFile(path string) (time.Time, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return time.Time{}, ErrNoAuthFile
	}
	if err != nil {
		return time.Time{}, err
	}
	if ts, parseErr := lastRefreshFrom(raw); parseErr == nil {
		return ts, nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return time.Time{}, err
	}
	return info.ModTime().UTC(), nil
}

func hasAnyClaudeToken(doc map[string]any) bool {
	if k, _ := doc["api_key"].(string); strings.TrimSpace(k) != "" {
		return true
	}
	if k, _ := doc["anthropic_api_key"].(string); strings.TrimSpace(k) != "" {
		return true
	}
	if oauth, ok := doc["claudeAiOauth"].(map[string]any); ok {
		if t, _ := oauth["accessToken"].(string); strings.TrimSpace(t) != "" {
			return true
		}
	}
	if auths, ok := doc["auths"].(map[string]any); ok && len(auths) > 0 {
		if e, ok := auths["api.anthropic.com"].(map[string]any); ok {
			if t, _ := e["token"].(string); strings.TrimSpace(t) != "" {
				return true
			}
		}
	}
	return false
}

func lastRefreshFrom(raw []byte) (time.Time, error) {
	var doc struct {
		LastRefresh string `json:"last_refresh"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return time.Time{}, err
	}
	ts := strings.TrimSpace(doc.LastRefresh)
	if ts == "" {
		return time.Time{}, errors.New("credentials.json: missing last_refresh")
	}
	return parseISO8601(ts)
}

func parseISO8601(s string) (time.Time, error) {
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

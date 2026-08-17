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
	"path/filepath"
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
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return false, errors.New("credentials.json: invalid JSON")
	}
	kind, _, usable := runnableCredentialIdentity(doc)
	if !usable {
		return false, errors.New("credentials.json: no runnable Claude credential")
	}
	if kind == "oauth" {
		return oauthIsFresh(path, raw, doc, window)
	}
	ts, err := lastRefreshFrom(raw)
	if err != nil {
		// Direct API-key logins have no token expiry and normally no fleet
		// last_refresh. Use the digest-bound wrapper generation when present,
		// otherwise the native file mtime, with the same bounded 24h/7d windows.
		ts, err = nativeCredentialRefresh(path, raw)
		if err != nil {
			return false, err
		}
	}
	return withinRefreshWindow(ts, window), nil
}

func oauthIsFresh(path string, raw []byte, doc map[string]any, window time.Duration) (bool, error) {
	oauth, _ := doc["claudeAiOauth"].(map[string]any)
	now := time.Now().UTC()
	if accessExpiry, known := epochMillis(oauth["expiresAt"]); known && accessExpiry.After(now) {
		// The current access token is directly runnable. It needs no refresh or
		// wrapper freshness proof until its own signed lifetime ends.
		return true, nil
	}

	refresh, _ := oauth["refreshToken"].(string)
	if strings.TrimSpace(refresh) == "" {
		return false, nil
	}
	if refreshExpiry, known := epochMillis(oauth["refreshTokenExpiresAt"]); known && !refreshExpiry.After(now) {
		return false, nil
	}

	// Expired or un-dated access plus a usable refresh token is still runnable:
	// native Claude refreshes it itself. Bound that fallback to the exact
	// wrapper generation or native file mtime so an indefinitely stale refresh
	// token cannot unlock offline use.
	ts, err := nativeCredentialRefresh(path, raw)
	if err != nil {
		return false, err
	}
	return withinRefreshWindow(ts, window), nil
}

func withinRefreshWindow(ts time.Time, window time.Duration) bool {
	now := time.Now().UTC()
	delta := now.Sub(ts)
	if delta < -maxFutureSkew {
		return false
	}
	return delta <= window
}

// epochMillis parses Claude Code's Unix epoch millisecond expiry fields.
func epochMillis(value any) (time.Time, bool) {
	number, ok := value.(float64)
	if !ok || number <= 0 || number > float64(^uint64(0)>>1) {
		return time.Time{}, false
	}
	millis := int64(number)
	if float64(millis) != number {
		return time.Time{}, false
	}
	return time.UnixMilli(millis).UTC(), true
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
	return nativeCredentialRefresh(path, raw)
}

func nativeCredentialRefresh(path string, raw []byte) (time.Time, error) {
	info, err := os.Stat(path)
	if err != nil {
		return time.Time{}, err
	}
	nativePath, pathErr := AuthPath()
	if pathErr == nil && filepath.Clean(path) == filepath.Clean(nativePath) {
		paths, pathsErr := authFiles()
		if pathsErr == nil {
			state := readGenerationState(paths.generation)
			if state.Digest == digestBytes(raw) && validGenerationStateRefresh(state) {
				if stamp, parseErr := time.Parse(time.RFC3339Nano, state.LastRefresh); parseErr == nil {
					return stamp.UTC(), nil
				}
			}
		}
	}
	return info.ModTime().UTC(), nil
}

func hasAnyClaudeToken(doc map[string]any) bool {
	_, _, ok := runnableCredentialIdentity(doc)
	return ok
}

func runnableCredentialIdentity(doc map[string]any) (kind, token string, ok bool) {
	if oauth, present := doc["claudeAiOauth"].(map[string]any); present {
		if value, _ := oauth["accessToken"].(string); strings.TrimSpace(value) != "" {
			return "oauth", strings.TrimSpace(value), true
		}
	}
	for _, key := range []string{"api_key", "anthropic_api_key", "ANTHROPIC_API_KEY"} {
		if value, _ := doc[key].(string); isRunnableAnthropicAPIKey(value) {
			return "api_key", strings.TrimSpace(value), true
		}
	}
	if tokens, present := doc["tokens"].(map[string]any); present {
		for _, key := range []string{"anthropic_api_key", "ANTHROPIC_API_KEY"} {
			if value, _ := tokens[key].(string); isRunnableAnthropicAPIKey(value) {
				return "api_key", strings.TrimSpace(value), true
			}
		}
	}
	if auths, ok := doc["auths"].(map[string]any); ok && len(auths) > 0 {
		if e, ok := auths["api.anthropic.com"].(map[string]any); ok {
			// Claude Code cannot consume a Claude.ai OAuth bearer from the
			// orchestrator-only auths map. OAuth is runnable only in its native
			// claudeAiOauth shape; auths is a valid local fallback solely for a
			// genuine Anthropic API key that PreExec can export.
			if t, _ := e["token"].(string); isRunnableAnthropicAPIKey(t) {
				return "api_key", strings.TrimSpace(t), true
			}
		}
	}
	return "", "", false
}

func isRunnableAnthropicAPIKey(value string) bool {
	token := strings.TrimSpace(value)
	return token != "" && !strings.HasPrefix(strings.ToLower(token), "sk-ant-oat")
}

// SameCredentialPair compares the exact credential generation the runner
// verifies under the shared precedence rules. OAuth identity includes both
// access and refresh tokens: a rotated refresh token is a distinct generation
// even when the short-lived access token happens to be unchanged. API-key
// identity is the selected key alone. Wrapper timestamps, formatting, and
// non-auth metadata do not create a new credential identity.
func SameCredentialPair(left, right json.RawMessage) bool {
	var leftDoc, rightDoc map[string]any
	if json.Unmarshal(left, &leftDoc) != nil || json.Unmarshal(right, &rightDoc) != nil {
		return false
	}
	leftKind, leftAccess, leftRefresh, leftOK := runnableCredentialPair(leftDoc)
	rightKind, rightAccess, rightRefresh, rightOK := runnableCredentialPair(rightDoc)
	return leftOK &&
		rightOK &&
		leftKind == rightKind &&
		leftAccess == rightAccess &&
		leftRefresh == rightRefresh
}

func runnableCredentialPair(doc map[string]any) (kind, access, refresh string, ok bool) {
	kind, access, ok = runnableCredentialIdentity(doc)
	if !ok {
		return "", "", "", false
	}
	if kind != "oauth" {
		return kind, access, "", true
	}
	oauth, _ := doc["claudeAiOauth"].(map[string]any)
	refresh, _ = oauth["refreshToken"].(string)
	return kind, access, strings.TrimSpace(refresh), true
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

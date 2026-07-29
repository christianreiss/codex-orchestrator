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
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strconv"
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

var minAuthTimestamp = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

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
	if !isValidAuthRaw(raw) {
		return false, errors.New("auth.json: no credential runnable by native Codex")
	}
	now := time.Now().UTC()
	if !authCanRunOrRefresh(raw, now) {
		return false, nil
	}
	ts, err := lastRefreshFrom(raw)
	if err != nil {
		// Native `codex login` credentials intentionally have no orchestrator
		// last_refresh. Treat the file mtime as that generation's freshness,
		// after proving the token document is structurally usable; an arbitrary
		// or corrupt recently-written file must not unlock offline fallback.
		st, statErr := os.Stat(path)
		if statErr != nil {
			return false, statErr
		}
		ts = st.ModTime().UTC()
	}
	delta := now.Sub(ts)
	if delta < -maxFutureSkew {
		trusted, trustErr := trustedGenerationKnownAt(path, generationOf(raw))
		if trustErr != nil {
			return false, trustErr
		}
		if trusted && validLogicalAuthTimestamp(ts) {
			return true, nil
		}
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
// This follows native Codex AuthDotJson selection exactly:
//
//   - explicit `apikey` selects top-level `OPENAI_API_KEY`
//   - explicit `chatgpt`/`chatgptAuthTokens` selects `tokens.access_token`
//   - absent/null mode rejects non-null PAT/Bedrock selectors, then selects
//     top-level `OPENAI_API_KEY` when present, otherwise ChatGPT tokens
//
// Legacy `auths` and nested API-key projections are server upload/normalization
// shapes only. Native Codex does not consume them, so they cannot make a local
// file launchable or eligible for offline fallback.
func IsValidLocalAuth(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return isValidAuthRaw(raw)
}

func isValidAuthRaw(raw []byte) bool {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return false
	}
	_, ok := resolveNativeAuth(doc)
	return ok
}

type nativeAuthCredential struct {
	mode    string
	access  string
	refresh string
}

func resolveNativeAuth(doc map[string]any) (nativeAuthCredential, bool) {
	if mode, present := doc["auth_mode"]; present && mode != nil {
		modeName, ok := mode.(string)
		if !ok {
			return nativeAuthCredential{}, false
		}
		switch modeName {
		case "apikey":
			access, ok := authString(doc["OPENAI_API_KEY"])
			return nativeAuthCredential{mode: "apikey", access: access}, ok
		case "chatgpt", "chatgptAuthTokens":
			return resolveChatGPTAuth(doc)
		default:
			return nativeAuthCredential{}, false
		}
	}

	if value, present := doc["personal_access_token"]; present && value != nil {
		return nativeAuthCredential{}, false
	}
	if value, present := doc["bedrock_api_key"]; present && value != nil {
		return nativeAuthCredential{}, false
	}
	if value, present := doc["OPENAI_API_KEY"]; present && value != nil {
		access, ok := authString(value)
		return nativeAuthCredential{mode: "apikey", access: access}, ok
	}
	return resolveChatGPTAuth(doc)
}

func resolveChatGPTAuth(doc map[string]any) (nativeAuthCredential, bool) {
	tokens, ok := doc["tokens"].(map[string]any)
	if !ok {
		return nativeAuthCredential{}, false
	}
	access, ok := authString(tokens["access_token"])
	if !ok {
		return nativeAuthCredential{}, false
	}
	refresh, _ := authString(tokens["refresh_token"])
	return nativeAuthCredential{mode: "chatgpt", access: access, refresh: refresh}, true
}

func authString(value any) (string, bool) {
	text, ok := value.(string)
	text = strings.TrimSpace(text)
	return text, ok && text != ""
}

// authCanRunOrRefresh rejects a definitively expired ChatGPT access JWT when
// native Codex has no refresh token with which to renew it. Opaque access
// tokens remain structurally usable because their expiry is unknowable; the
// normal last_refresh/mtime window still bounds offline fallback.
func authCanRunOrRefresh(raw []byte, now time.Time) bool {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return false
	}
	credential, ok := resolveNativeAuth(doc)
	if !ok || credential.mode != "chatgpt" {
		return ok
	}
	expiry, known := jwtExpiry(credential.access)
	if !known || expiry.After(now) {
		return true
	}
	return credential.refresh != ""
}

func jwtExpiry(token string) (time.Time, bool) {
	parts := strings.Split(token, ".")
	if len(parts) < 2 || strings.TrimSpace(parts[1]) == "" {
		return time.Time{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		ExpiresAt json.Number `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.ExpiresAt == "" {
		return time.Time{}, false
	}
	seconds, err := strconv.ParseInt(claims.ExpiresAt.String(), 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.Unix(seconds, 0).UTC(), true
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
	if !isValidAuthRaw(raw) {
		return time.Time{}, errors.New("auth.json: no credential runnable by native Codex")
	}
	if ts, perr := lastRefreshFrom(raw); perr == nil {
		if reasonableAuthTimestamp(ts, time.Now()) {
			return ts, nil
		}
		knownGeneration, knownErr := trustedGenerationKnownAt(path, generationOf(raw))
		if knownErr != nil {
			return time.Time{}, knownErr
		}
		if knownGeneration && validLogicalAuthTimestamp(ts) {
			return ts, nil
		}
		return time.Time{}, errors.New("auth.json: last_refresh outside accepted bounds")
	}
	st, err := os.Stat(path)
	if err != nil {
		return time.Time{}, err
	}
	ts := st.ModTime().UTC()
	if !reasonableAuthTimestamp(ts, time.Now()) {
		return time.Time{}, errors.New("auth.json: mtime outside accepted bounds")
	}
	return ts, nil
}

func reasonableAuthTimestamp(candidate, now time.Time) bool {
	candidate = candidate.UTC()
	now = now.UTC()
	return !candidate.Before(minAuthTimestamp) && !candidate.After(now.Add(maxFutureSkew))
}

// validLogicalAuthTimestamp validates a persisted ordering stamp without
// comparing it with the current host clock. Verified canonical generations
// can legitimately appear in the future after the clock moves backwards.
func validLogicalAuthTimestamp(candidate time.Time) bool {
	return !candidate.UTC().Before(minAuthTimestamp)
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

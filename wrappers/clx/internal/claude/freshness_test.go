package claude

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func writeCreds(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "credentials.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return p
}

func tsZ(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000000Z")
}

func TestIsFresh_Recent(t *testing.T) {
	p := writeCreds(t, `{"last_refresh":"`+tsZ(time.Now().Add(-2*time.Hour))+`","api_key":"sk-ant-api03-direct"}`)
	ok, err := IsFresh(p, MaxAge24h)
	if err != nil || !ok {
		t.Fatalf("want fresh: ok=%v err=%v", ok, err)
	}
}

func TestIsFresh_FutureSkewTolerated(t *testing.T) {
	p := writeCreds(t, `{"last_refresh":"`+tsZ(time.Now().Add(2*time.Minute))+`","api_key":"sk-ant-api03-direct"}`)
	ok, _ := IsFresh(p, MaxAge24h)
	if !ok {
		t.Fatalf("want fresh (within future skew)")
	}
}

func TestIsFresh_FutureSkewBeyondLimit(t *testing.T) {
	p := writeCreds(t, `{"last_refresh":"`+tsZ(time.Now().Add(10*time.Minute))+`","api_key":"sk-ant-api03-direct"}`)
	ok, _ := IsFresh(p, MaxAge24h)
	if ok {
		t.Fatalf("want stale (beyond future skew)")
	}
}

func TestIsFresh_SecureHostWindow(t *testing.T) {
	p := writeCreds(t, `{"last_refresh":"`+tsZ(time.Now().Add(-3*24*time.Hour))+`","api_key":"sk-ant-api03-direct"}`)
	if ok, _ := IsFresh(p, MaxAge24h); ok {
		t.Fatalf("3d should fail 24h")
	}
	if ok, _ := IsFresh(p, MaxAge7d); !ok {
		t.Fatalf("3d should pass 7d")
	}
}

func TestIsFresh_MissingFile(t *testing.T) {
	_, err := IsFresh(filepath.Join(t.TempDir(), "missing"), MaxAge24h)
	if err != ErrNoAuthFile {
		t.Fatalf("want ErrNoAuthFile, got %v", err)
	}
}

func TestIsFresh_OAuthExpiresAtFallback(t *testing.T) {
	// claudeAiOauth-only file (no last_refresh, as WriteAuth produces) with a
	// future expiry must be treated as fresh — the offline launch gate must not
	// refuse an OAuth host whose token is still valid.
	future := time.Now().Add(2 * time.Hour).UnixMilli()
	p := writeCreds(t, `{"claudeAiOauth":{"accessToken":"sk-ant-oat-x","expiresAt":`+itoa(future)+`}}`)
	ok, err := IsFresh(p, MaxAge24h)
	if err != nil || !ok {
		t.Fatalf("future-expiry OAuth creds should be fresh: ok=%v err=%v", ok, err)
	}
}

func TestIsFresh_OAuthExpiredIsStale(t *testing.T) {
	past := time.Now().Add(-1 * time.Hour).UnixMilli()
	p := writeCreds(t, `{"claudeAiOauth":{"accessToken":"sk-ant-oat-x","expiresAt":`+itoa(past)+`}}`)
	ok, _ := IsFresh(p, MaxAge24h)
	if ok {
		t.Fatalf("expired OAuth token must not be fresh")
	}
}

func TestIsFresh_ExpiredOAuthAccessWithUsableRefreshUsesBoundedGeneration(t *testing.T) {
	past := time.Now().Add(-1 * time.Hour).UnixMilli()
	refreshFuture := time.Now().Add(30 * 24 * time.Hour).UnixMilli()
	p := writeCreds(t, `{"claudeAiOauth":{"accessToken":"sk-ant-oat-x","refreshToken":"refresh","expiresAt":`+itoa(past)+`,"refreshTokenExpiresAt":`+itoa(refreshFuture)+`}}`)
	recent := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(p, recent, recent); err != nil {
		t.Fatal(err)
	}
	if ok, err := IsFresh(p, MaxAge24h); err != nil || !ok {
		t.Fatalf("refreshable OAuth should pass bounded offline window: ok=%v err=%v", ok, err)
	}
	threeDays := time.Now().Add(-3 * 24 * time.Hour)
	if err := os.Chtimes(p, threeDays, threeDays); err != nil {
		t.Fatal(err)
	}
	if ok, _ := IsFresh(p, MaxAge24h); ok {
		t.Fatal("three-day-old refreshable OAuth passed 24h window")
	}
	if ok, err := IsFresh(p, MaxAge7d); err != nil || !ok {
		t.Fatalf("three-day-old refreshable OAuth should pass secure 7d window: ok=%v err=%v", ok, err)
	}
}

func TestIsFresh_ExpiredOAuthRefreshIsStale(t *testing.T) {
	past := time.Now().Add(-1 * time.Hour).UnixMilli()
	refreshPast := time.Now().Add(-1 * time.Minute).UnixMilli()
	p := writeCreds(t, `{"claudeAiOauth":{"accessToken":"sk-ant-oat-x","refreshToken":"refresh","expiresAt":`+itoa(past)+`,"refreshTokenExpiresAt":`+itoa(refreshPast)+`}}`)
	if ok, err := IsFresh(p, MaxAge7d); err != nil || ok {
		t.Fatalf("known-expired refresh token must be stale: ok=%v err=%v", ok, err)
	}
}

func TestIsFresh_UndatedOAuthAccessWithRefreshUsesBoundedGeneration(t *testing.T) {
	p := writeCreds(t, `{"claudeAiOauth":{"accessToken":"sk-ant-oat-x","refreshToken":"refresh","expiresAt":"unknown"}}`)
	if ok, err := IsFresh(p, MaxAge24h); err != nil || !ok {
		t.Fatalf("undated refreshable OAuth should use bounded mtime: ok=%v err=%v", ok, err)
	}
}

func TestIsFresh_NoRefreshNoExpiry(t *testing.T) {
	// Neither last_refresh nor a usable expiresAt: must surface stale, not panic.
	p := writeCreds(t, `{"claudeAiOauth":{"accessToken":"sk-ant-oat-x"}}`)
	if ok, _ := IsFresh(p, MaxAge24h); ok {
		t.Fatalf("file without last_refresh or expiresAt must not be fresh")
	}
}

func TestIsFresh_APIKeyWithoutRefreshUsesBoundedMtime(t *testing.T) {
	p := writeCreds(t, `{"api_key":"sk-ant-api03-direct"}`)
	recent := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(p, recent, recent); err != nil {
		t.Fatal(err)
	}
	if ok, err := IsFresh(p, MaxAge24h); err != nil || !ok {
		t.Fatalf("recent direct API key should be fresh: ok=%v err=%v", ok, err)
	}

	threeDays := time.Now().Add(-3 * 24 * time.Hour)
	if err := os.Chtimes(p, threeDays, threeDays); err != nil {
		t.Fatal(err)
	}
	if ok, _ := IsFresh(p, MaxAge24h); ok {
		t.Fatal("three-day-old API key passed the 24h window")
	}
	if ok, err := IsFresh(p, MaxAge7d); err != nil || !ok {
		t.Fatalf("three-day-old API key should pass the secure 7d window: ok=%v err=%v", ok, err)
	}

	eightDays := time.Now().Add(-8 * 24 * time.Hour)
	if err := os.Chtimes(p, eightDays, eightDays); err != nil {
		t.Fatal(err)
	}
	if ok, _ := IsFresh(p, MaxAge7d); ok {
		t.Fatal("eight-day-old API key passed the secure 7d window")
	}
}

func TestIsFresh_APIKeyUsesDigestBoundGenerationBeforeMutableMtime(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"api_key":"sk-ant-api03-generation"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadAuthSnapshot(true); err != nil {
		t.Fatal(err)
	}
	stale := time.Now().Add(-8 * 24 * time.Hour)
	if err := os.Chtimes(path, stale, stale); err != nil {
		t.Fatal(err)
	}
	if ok, err := IsFresh(path, MaxAge24h); err != nil || !ok {
		t.Fatalf("digest-bound recent generation should win over later mtime drift: ok=%v err=%v", ok, err)
	}
}

func TestIsValidLocalAuth_OAuthOnly(t *testing.T) {
	p := writeCreds(t, `{"claudeAiOauth":{"accessToken":"sk"}}`)
	if !IsValidLocalAuth(p) {
		t.Fatalf("OAuth-only should be valid")
	}
}

func TestIsValidLocalAuth_AnthropicKey(t *testing.T) {
	p := writeCreds(t, `{
		"last_refresh":"`+tsZ(time.Now())+`",
		"anthropic_api_key":"sk-ant-xxx"
	}`)
	if !IsValidLocalAuth(p) {
		t.Fatalf("anthropic_api_key should be valid")
	}
}

func TestIsValidLocalAuth_AuthsMap(t *testing.T) {
	p := writeCreds(t, `{
		"last_refresh":"`+tsZ(time.Now())+`",
		"auths":{"api.anthropic.com":{"token":"t"}}
	}`)
	if !IsValidLocalAuth(p) {
		t.Fatalf("auths-map should be valid")
	}
}

func TestIsValidLocalAuth_AuthsOAuthBearerNeedsNativeOAuthShape(t *testing.T) {
	p := writeCreds(t, `{"auths":{"api.anthropic.com":{"token":"sk-ant-oat01-derived-only"}}}`)
	if IsValidLocalAuth(p) {
		t.Error("derived OAuth bearer in auths is not runnable by Claude Code")
	}
}

func TestIsValidLocalAuth_EmptyOAuthDoesNotHideGenuineAPIKey(t *testing.T) {
	p := writeCreds(t, `{"claudeAiOauth":{"accessToken":"","refreshToken":""},"auths":{"api.anthropic.com":{"token":"sk-ant-api03-real"}}}`)
	if !IsValidLocalAuth(p) {
		t.Error("genuine Anthropic API key should remain runnable")
	}
}

func TestRunnableCredentialIdentityUsesRuntimePrecedence(t *testing.T) {
	oauthFirst := map[string]any{
		"claudeAiOauth": map[string]any{"accessToken": "sk-ant-oat01-native"},
		"api_key":       "sk-ant-api03-stale-flat",
		"auths":         map[string]any{"api.anthropic.com": map[string]any{"token": "sk-ant-api03-stale-auths"}},
	}
	kind, token, ok := runnableCredentialIdentity(oauthFirst)
	if !ok || kind != "oauth" || token != "sk-ant-oat01-native" {
		t.Fatalf("OAuth precedence identity=(%q,%q,%v)", kind, token, ok)
	}
	apiFirst := map[string]any{
		"api_key":           "sk-ant-api03-flat",
		"anthropic_api_key": "sk-ant-api03-anthropic",
		"ANTHROPIC_API_KEY": "sk-ant-api03-env",
		"auths":             map[string]any{"api.anthropic.com": map[string]any{"token": "sk-ant-api03-auths"}},
	}
	kind, token, ok = runnableCredentialIdentity(apiFirst)
	if !ok || kind != "api_key" || token != "sk-ant-api03-flat" {
		t.Fatalf("API-key precedence identity=(%q,%q,%v)", kind, token, ok)
	}
	if !SameCredentialPair(
		[]byte(`{"api_key":"sk-ant-api03-same","last_refresh":"2026-07-24T08:00:00Z"}`),
		[]byte(`{"auths":{"api.anthropic.com":{"token":"sk-ant-api03-same"}}}`),
	) {
		t.Fatal("equivalent API-key shapes did not share credential identity")
	}
	if SameCredentialPair(
		[]byte(`{"claudeAiOauth":{"accessToken":"sk-ant-oat01-same","refreshToken":"refresh-a"}}`),
		[]byte(`{"claudeAiOauth":{"accessToken":"sk-ant-oat01-same","refreshToken":"refresh-b"}}`),
	) {
		t.Fatal("rotated OAuth refresh token must create a new credential pair")
	}
	if !SameCredentialPair(
		[]byte(`{"claudeAiOauth":{"accessToken":"sk-ant-oat01-same","refreshToken":"refresh-a"},"last_refresh":"2026-07-24T08:00:00Z"}`),
		[]byte("{\n  \"claudeAiOauth\":{\"refreshToken\":\"refresh-a\",\"accessToken\":\"sk-ant-oat01-same\"},\n  \"metadata\":\"changed\"\n}"),
	) {
		t.Fatal("non-auth metadata must not create a new OAuth credential pair")
	}
}

func TestIsValidLocalAuth_Empty(t *testing.T) {
	p := writeCreds(t, `{}`)
	if IsValidLocalAuth(p) {
		t.Fatalf("empty doc should be invalid")
	}
}

func TestIsValidLocalAuth_MissingFile(t *testing.T) {
	if IsValidLocalAuth(filepath.Join(t.TempDir(), "nope")) {
		t.Fatalf("missing file should be invalid")
	}
}

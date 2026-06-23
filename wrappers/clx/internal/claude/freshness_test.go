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
	p := writeCreds(t, `{"last_refresh":"`+tsZ(time.Now().Add(-2*time.Hour))+`"}`)
	ok, err := IsFresh(p, MaxAge24h)
	if err != nil || !ok {
		t.Fatalf("want fresh: ok=%v err=%v", ok, err)
	}
}

func TestIsFresh_FutureSkewTolerated(t *testing.T) {
	p := writeCreds(t, `{"last_refresh":"`+tsZ(time.Now().Add(2*time.Minute))+`"}`)
	ok, _ := IsFresh(p, MaxAge24h)
	if !ok {
		t.Fatalf("want fresh (within future skew)")
	}
}

func TestIsFresh_FutureSkewBeyondLimit(t *testing.T) {
	p := writeCreds(t, `{"last_refresh":"`+tsZ(time.Now().Add(10*time.Minute))+`"}`)
	ok, _ := IsFresh(p, MaxAge24h)
	if ok {
		t.Fatalf("want stale (beyond future skew)")
	}
}

func TestIsFresh_SecureHostWindow(t *testing.T) {
	p := writeCreds(t, `{"last_refresh":"`+tsZ(time.Now().Add(-3*24*time.Hour))+`"}`)
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

func TestIsFresh_NoRefreshNoExpiry(t *testing.T) {
	// Neither last_refresh nor a usable expiresAt: must surface stale, not panic.
	p := writeCreds(t, `{"claudeAiOauth":{"accessToken":"sk-ant-oat-x"}}`)
	if ok, _ := IsFresh(p, MaxAge24h); ok {
		t.Fatalf("file without last_refresh or expiresAt must not be fresh")
	}
}

func TestIsFresh_LastRefreshWinsOverExpiry(t *testing.T) {
	// A recent last_refresh stays the primary signal even when expiresAt is set.
	future := time.Now().Add(2 * time.Hour).UnixMilli()
	p := writeCreds(t, `{"last_refresh":"`+tsZ(time.Now().Add(-2*time.Hour))+`","claudeAiOauth":{"expiresAt":`+itoa(future)+`}}`)
	if ok, err := IsFresh(p, MaxAge24h); err != nil || !ok {
		t.Fatalf("recent last_refresh should be fresh: ok=%v err=%v", ok, err)
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

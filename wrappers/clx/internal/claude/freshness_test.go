package claude

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

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

package codex

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func writeAuth(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return p
}

func tsZ(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000000Z")
}

func accessJWTWithExpiry(t time.Time) string {
	payload := `{"exp":` + strconv.FormatInt(t.Unix(), 10) + `}`
	return "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".signature"
}

func TestIsFresh_RecentWithinWindow(t *testing.T) {
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now().Add(-2*time.Hour))+`","tokens":{"access_token":"valid"}}`)
	ok, err := IsFresh(p, MaxAge24h)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !ok {
		t.Fatalf("want fresh")
	}
}

func TestIsFresh_BeyondWindow(t *testing.T) {
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now().Add(-25*time.Hour))+`","tokens":{"access_token":"valid"}}`)
	ok, _ := IsFresh(p, MaxAge24h)
	if ok {
		t.Fatalf("want stale")
	}
}

func TestIsFresh_FutureSkewWithinTolerance(t *testing.T) {
	// 1 minute in the future is within ±5 min tolerance.
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now().Add(1*time.Minute))+`","tokens":{"access_token":"valid"}}`)
	ok, err := IsFresh(p, MaxAge24h)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !ok {
		t.Fatalf("want fresh (within future skew)")
	}
}

func TestIsFresh_FutureSkewBeyondTolerance(t *testing.T) {
	// 10 minutes in the future is past the 5 min skew → reject.
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now().Add(10*time.Minute))+`","tokens":{"access_token":"valid"}}`)
	ok, _ := IsFresh(p, MaxAge24h)
	if ok {
		t.Fatalf("want stale (future-skew beyond tolerance)")
	}
}

func TestIsFresh_SecureHostRecentWindow(t *testing.T) {
	// 3 days old → within 7d but outside 24h.
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now().Add(-3*24*time.Hour))+`","tokens":{"access_token":"valid"}}`)
	if ok, _ := IsFresh(p, MaxAge24h); ok {
		t.Fatalf("3d should fail 24h window")
	}
	if ok, err := IsFresh(p, MaxAge7d); !ok {
		t.Fatalf("3d should pass 7d window: ok=%v err=%v", ok, err)
	}
}

func TestIsFresh_MissingFile(t *testing.T) {
	_, err := IsFresh(filepath.Join(t.TempDir(), "missing"), MaxAge24h)
	if err != ErrNoAuthFile {
		t.Fatalf("want ErrNoAuthFile, got %v", err)
	}
}

func TestIsFresh_BadJSON(t *testing.T) {
	p := writeAuth(t, `not-json`)
	if _, err := IsFresh(p, MaxAge24h); err == nil {
		t.Fatalf("expected error on bad JSON")
	}
}

func TestIsFresh_MissingLastRefresh(t *testing.T) {
	p := writeAuth(t, `{"foo":"bar"}`)
	if _, err := IsFresh(p, MaxAge24h); err == nil {
		t.Fatalf("expected error when last_refresh missing")
	}
}

func TestIsFresh_NativeLoginUsesMtimeOnlyWhenStructurallyValid(t *testing.T) {
	p := writeAuth(t, `{"tokens":{"access_token":"fresh-native"}}`)
	if ok, err := IsFresh(p, MaxAge24h); err != nil || !ok {
		t.Fatalf("fresh native login should support offline fallback: ok=%v err=%v", ok, err)
	}
	old := time.Now().Add(-25 * time.Hour)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatal(err)
	}
	if ok, _ := IsFresh(p, MaxAge24h); ok {
		t.Fatal("old native login mtime must not pass 24h fallback")
	}
	invalid := writeAuth(t, `{"tokens":{}}`)
	if ok, err := IsFresh(invalid, MaxAge24h); err == nil || ok {
		t.Fatalf("recent invalid file must not pass mtime fallback: ok=%v err=%v", ok, err)
	}
}

func TestIsFresh_ExpiredAccessJWTRequiresRefreshToken(t *testing.T) {
	expired := accessJWTWithExpiry(time.Now().Add(-time.Hour))
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now())+`","tokens":{"access_token":"`+expired+`"}}`)
	if ok, err := IsFresh(p, MaxAge24h); err != nil || ok {
		t.Fatalf("expired access JWT without refresh token must be stale: ok=%v err=%v", ok, err)
	}

	withRefresh := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now())+`","tokens":{"access_token":"`+expired+`","refresh_token":"refresh"}}`)
	if ok, err := IsFresh(withRefresh, MaxAge24h); err != nil || !ok {
		t.Fatalf("native Codex can renew expired access JWT with refresh token: ok=%v err=%v", ok, err)
	}

	future := accessJWTWithExpiry(time.Now().Add(time.Hour))
	withoutRefresh := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now())+`","tokens":{"access_token":"`+future+`"}}`)
	if ok, err := IsFresh(withoutRefresh, MaxAge24h); err != nil || !ok {
		t.Fatalf("unexpired access JWT is directly runnable: ok=%v err=%v", ok, err)
	}
}

func TestIsFresh_TimezoneOffsetParses(t *testing.T) {
	// +02:00 offset 1 hour ago — valid.
	now := time.Now().In(time.FixedZone("CEST", 2*3600)).Add(-1 * time.Hour)
	body := `{"last_refresh":"` + now.Format("2006-01-02T15:04:05-07:00") + `","tokens":{"access_token":"valid"}}`
	p := writeAuth(t, body)
	if ok, err := IsFresh(p, MaxAge24h); err != nil || !ok {
		t.Fatalf("offset parse failed: ok=%v err=%v", ok, err)
	}
}

func TestIsValidLocalAuth_WithAuths(t *testing.T) {
	p := writeAuth(t, `{
		"last_refresh":"`+tsZ(time.Now())+`",
		"auths":{"chatgpt":{"token":"t"}}
	}`)
	if IsValidLocalAuth(p) {
		t.Fatalf("legacy auths-only projection is not runnable by native Codex")
	}
}

func TestIsValidLocalAuth_WithFallbackToken(t *testing.T) {
	p := writeAuth(t, `{
		"last_refresh":"`+tsZ(time.Now())+`",
		"tokens":{"access_token":"abc"}
	}`)
	if !IsValidLocalAuth(p) {
		t.Fatalf("want valid (fallback access_token)")
	}
}

func TestIsValidLocalAuth_WithOpenAIKey(t *testing.T) {
	p := writeAuth(t, `{
		"last_refresh":"`+tsZ(time.Now())+`",
		"OPENAI_API_KEY":"sk-test"
	}`)
	if !IsValidLocalAuth(p) {
		t.Fatalf("want valid (OPENAI_API_KEY)")
	}
}

func TestIsValidLocalAuth_MissingLastRefresh(t *testing.T) {
	// Vanilla `codex login` files carry no last_refresh — they must still count
	// as structurally valid (upstream codex only needs the tokens). Requiring
	// the stamp made a freshly-minted login "invalid" for concurrent runs and
	// failed-verification fallback.
	p := writeAuth(t, `{"tokens":{"access_token":"native-login"}}`)
	if !IsValidLocalAuth(p) {
		t.Fatalf("want valid (vanilla login file without last_refresh)")
	}
}

func TestIsValidLocalAuth_EmptyAuthsNoFallback(t *testing.T) {
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now())+`","auths":{}}`)
	if IsValidLocalAuth(p) {
		t.Fatalf("want invalid (empty auths, no fallback)")
	}
}

func TestIsValidLocalAuth_AuthsEntryMissingToken(t *testing.T) {
	p := writeAuth(t, `{
		"last_refresh":"`+tsZ(time.Now())+`",
		"auths":{"chatgpt":{"token":""}}
	}`)
	if IsValidLocalAuth(p) {
		t.Fatalf("want invalid (empty token)")
	}
}

func TestIsValidLocalAuthMatchesNativeModeSelection(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want bool
	}{
		{name: "explicit apikey", body: `{"auth_mode":"apikey","OPENAI_API_KEY":"sk-key"}`, want: true},
		{name: "explicit apikey does not fall through to tokens", body: `{"auth_mode":"apikey","OPENAI_API_KEY":"","tokens":{"access_token":"chatgpt"}}`},
		{name: "explicit chatgpt", body: `{"auth_mode":"chatgpt","tokens":{"access_token":"oauth"}}`, want: true},
		{name: "explicit legacy chatgpt mode", body: `{"auth_mode":"chatgptAuthTokens","tokens":{"access_token":"oauth"}}`, want: true},
		{name: "explicit chatgpt does not fall through to key", body: `{"auth_mode":"chatgpt","tokens":{},"OPENAI_API_KEY":"sk-key"}`},
		{name: "explicit unsupported PAT mode", body: `{"auth_mode":"personalAccessToken","personal_access_token":"pat","OPENAI_API_KEY":"sk-key"}`},
		{name: "explicit unsupported Bedrock mode", body: `{"auth_mode":"bedrockApiKey","bedrock_api_key":"bedrock","tokens":{"access_token":"oauth"}}`},
		{name: "explicit headers mode", body: `{"auth_mode":"headers","OPENAI_API_KEY":"sk-key"}`},
		{name: "explicit agent identity mode", body: `{"auth_mode":"agentIdentity","tokens":{"access_token":"oauth"}}`},
		{name: "unknown explicit mode", body: `{"auth_mode":"future","OPENAI_API_KEY":"sk-key"}`},
		{name: "non-string explicit mode", body: `{"auth_mode":1,"OPENAI_API_KEY":"sk-key"}`},
		{name: "null mode infers key", body: `{"auth_mode":null,"OPENAI_API_KEY":"sk-key","tokens":{"access_token":"oauth"}}`, want: true},
		{name: "absent mode key precedes tokens", body: `{"OPENAI_API_KEY":"sk-key","tokens":{"access_token":"oauth"}}`, want: true},
		{name: "present empty key blocks token fallback", body: `{"OPENAI_API_KEY":"","tokens":{"access_token":"oauth"}}`},
		{name: "present non-string key blocks token fallback", body: `{"OPENAI_API_KEY":42,"tokens":{"access_token":"oauth"}}`},
		{name: "null key falls through to tokens", body: `{"OPENAI_API_KEY":null,"tokens":{"access_token":"oauth"}}`, want: true},
		{name: "absent mode tokens", body: `{"tokens":{"access_token":"oauth"}}`, want: true},
		{name: "PAT presence blocks shadow key", body: `{"personal_access_token":"","OPENAI_API_KEY":"sk-key"}`},
		{name: "null PAT does not select PAT", body: `{"personal_access_token":null,"OPENAI_API_KEY":"sk-key"}`, want: true},
		{name: "Bedrock presence blocks shadow tokens", body: `{"bedrock_api_key":"","tokens":{"access_token":"oauth"}}`},
		{name: "null Bedrock does not select Bedrock", body: `{"bedrock_api_key":null,"tokens":{"access_token":"oauth"}}`, want: true},
		{name: "nested key is ignored", body: `{"tokens":{"openai_api_key":"sk-nested"}}`},
		{name: "auths cannot rescue explicit mode", body: `{"auth_mode":"apikey","auths":{"api.openai.com":{"token":"legacy"}}}`},
		{name: "auths only ignored", body: `{"auths":{"api.openai.com":{"token":"legacy"}}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsValidLocalAuth(writeAuth(t, tc.body)); got != tc.want {
				t.Fatalf("IsValidLocalAuth=%v want=%v body=%s", got, tc.want, tc.body)
			}
		})
	}
}

func TestIsFreshRejectsStampedLegacyAuthsOnly(t *testing.T) {
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now())+`","auths":{"api.openai.com":{"token":"legacy"}}}`)
	if ok, err := IsFresh(p, MaxAge24h); ok || err == nil {
		t.Fatalf("auths-only cache became offline-usable: ok=%v err=%v", ok, err)
	}
}

func TestIsValidLocalAuth_MissingFile(t *testing.T) {
	if IsValidLocalAuth(filepath.Join(t.TempDir(), "nope")) {
		t.Fatalf("want invalid")
	}
}

func TestIsValidLocalAuth_BadJSON(t *testing.T) {
	p := writeAuth(t, `not-json`)
	if IsValidLocalAuth(p) {
		t.Fatalf("want invalid")
	}
}

func TestLastRefreshOfFile_UsesStamp(t *testing.T) {
	stamp := time.Now().Add(-30 * 24 * time.Hour) // stamp far older than mtime
	p := writeAuth(t, `{"last_refresh":"`+tsZ(stamp)+`","tokens":{"access_token":"valid"}}`)
	got, err := LastRefreshOfFile(p)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got.Sub(stamp.UTC()).Abs() > time.Second {
		t.Fatalf("want stamp time %v, got %v (must not fall back to mtime)", stamp.UTC(), got)
	}
}

func TestLastRefreshOfFile_MtimeFallbackForVanillaLogin(t *testing.T) {
	// Vanilla `codex login` files have no last_refresh; the file mtime is the
	// only freshness signal — without it a fresh login compares older than any
	// stale canonical and gets clobbered.
	p := writeAuth(t, `{"tokens":{"access_token":"native-login"}}`)
	got, err := LastRefreshOfFile(p)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if time.Since(got) > time.Minute {
		t.Fatalf("want ~now via mtime, got %v", got)
	}
}

func TestLastRefreshOfFile_Missing(t *testing.T) {
	if _, err := LastRefreshOfFile(filepath.Join(t.TempDir(), "auth.json")); err == nil {
		t.Fatalf("want error for missing file")
	}
}

func TestLastRefreshFromRaw(t *testing.T) {
	stamp := time.Date(2026, 6, 8, 15, 26, 33, 0, time.UTC)
	got, err := LastRefreshFromRaw([]byte(`{"last_refresh":"2026-06-08T15:26:33Z"}`))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !got.Equal(stamp) {
		t.Fatalf("want %v, got %v", stamp, got)
	}
	if _, err := LastRefreshFromRaw([]byte(`{}`)); err == nil {
		t.Fatalf("want error when stamp absent")
	}
}

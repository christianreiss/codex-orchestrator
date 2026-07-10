package codex

import (
	"os"
	"path/filepath"
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

func TestIsFresh_RecentWithinWindow(t *testing.T) {
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now().Add(-2*time.Hour))+`"}`)
	ok, err := IsFresh(p, MaxAge24h)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !ok {
		t.Fatalf("want fresh")
	}
}

func TestIsFresh_BeyondWindow(t *testing.T) {
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now().Add(-25*time.Hour))+`"}`)
	ok, _ := IsFresh(p, MaxAge24h)
	if ok {
		t.Fatalf("want stale")
	}
}

func TestIsFresh_FutureSkewWithinTolerance(t *testing.T) {
	// 1 minute in the future is within ±5 min tolerance.
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now().Add(1*time.Minute))+`"}`)
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
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now().Add(10*time.Minute))+`"}`)
	ok, _ := IsFresh(p, MaxAge24h)
	if ok {
		t.Fatalf("want stale (future-skew beyond tolerance)")
	}
}

func TestIsFresh_SecureHostRecentWindow(t *testing.T) {
	// 3 days old → within 7d but outside 24h.
	p := writeAuth(t, `{"last_refresh":"`+tsZ(time.Now().Add(-3*24*time.Hour))+`"}`)
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

func TestIsFresh_TimezoneOffsetParses(t *testing.T) {
	// +02:00 offset 1 hour ago — valid.
	now := time.Now().In(time.FixedZone("CEST", 2*3600)).Add(-1 * time.Hour)
	body := `{"last_refresh":"` + now.Format("2006-01-02T15:04:05-07:00") + `"}`
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
	if !IsValidLocalAuth(p) {
		t.Fatalf("want valid")
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
	p := writeAuth(t, `{"auths":{"x":{"token":"t"}}}`)
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
	p := writeAuth(t, `{"last_refresh":"`+tsZ(stamp)+`","auths":{"x":{"token":"t"}}}`)
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
	p := writeAuth(t, `{"auths":{"x":{"token":"t"}}}`)
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

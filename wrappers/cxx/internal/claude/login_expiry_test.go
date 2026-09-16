package claude

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestLoginExpiryBoundaries(t *testing.T) {
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name      string
		remaining time.Duration
		want      string
	}{
		{"outside", 72*time.Hour + time.Millisecond, ""},
		{"three days", 72 * time.Hour, "expires in 3 days"},
		{"round up", 24*time.Hour + time.Millisecond, "expires in 2 days"},
		{"one day", 24 * time.Hour, "expires in 1 day"},
		{"one millisecond", time.Millisecond, "expires in 1 day"},
		{"boundary", 0, "login expired"}, {"past", -time.Hour, "login expired"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, _ := json.Marshal(map[string]any{"claudeAiOauth": map[string]any{"accessToken": "test", "refreshTokenExpiresAt": now.Add(tc.remaining).UnixMilli(), "expiresAt": now.Add(time.Hour).UnixMilli()}})
			got := loginExpiryWarning(raw, now)
			if tc.want == "" {
				if got != "" {
					t.Fatal(got)
				}
			} else if !strings.Contains(got, tc.want) || !strings.Contains(got, "Run /login") {
				t.Fatal(got)
			}
		})
	}
}

func TestLoginExpiryUnknownAndOtherCredentials(t *testing.T) {
	for _, raw := range []string{`{`, `{}`, `{"api_key":"test"}`, `{"claudeAiOauth":{"accessToken":"test"}}`, `{"claudeAiOauth":{"accessToken":"test","refreshTokenExpiresAt":"tomorrow"}}`, `{"claudeAiOauth":{"accessToken":"test","refreshTokenExpiresAt":-1}}`, `{"claudeAiOauth":{"accessToken":"test","refreshTokenExpiresAt":1e30}}`} {
		if got := loginExpiryWarning([]byte(raw), time.Now()); got != "" {
			t.Fatal(got)
		}
	}
}

func TestLoginExpiryLongLivedAccess(t *testing.T) {
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	expiry := now.Add(time.Hour)
	for _, offset := range []time.Duration{72 * time.Hour, 72*time.Hour + time.Millisecond} {
		raw, _ := json.Marshal(map[string]any{"claudeAiOauth": map[string]any{"accessToken": "test", "refreshTokenExpiresAt": expiry.UnixMilli(), "expiresAt": expiry.Add(offset).UnixMilli()}})
		got := loginExpiryWarning(raw, now)
		if (got == "") != (offset > 72*time.Hour) {
			t.Fatal(got)
		}
	}
}

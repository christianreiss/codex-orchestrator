package claude

import "testing"

func TestIsDeadTokenClearMatchesOnlyClaudeCodesInvalidGrantRecord(t *testing.T) {
	cases := map[string]bool{
		// Claude Code's EWs(): {...k, refreshToken:"", accessToken:"", expiresAt:0, loginEnded}
		`{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,"accountUuid":"a"}}`:         true,
		`{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,"loginEnded":"time_limit"}}`: true,
		`{"claudeAiOauth":{"accessToken":"live","refreshToken":"r","expiresAt":1}}`:                      false,
		`{"claudeAiOauth":{"accessToken":"","refreshToken":"still-here"}}`:                               false,
		`{}`:                           false, // /logout removes the claudeAiOauth block
		`{"api_key":"sk-ant-api03-x"}`: false,
		`null`:                         false,
		`not json`:                     false,
	}
	for raw, want := range cases {
		if got := IsDeadTokenClear([]byte(raw)); got != want {
			t.Errorf("IsDeadTokenClear(%s) = %v, want %v", raw, got, want)
		}
	}
}

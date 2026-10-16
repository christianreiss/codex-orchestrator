package nativeargs

import "testing"

func TestAuthGrammarRejectsMalformedArgvBeforeManagedEffects(t *testing.T) {
	for _, engine := range []string{"codex", "grok"} {
		for _, args := range [][]string{
			{"--not-a-native-flag", "logout"}, {"--not-a-native-flag", "login"},
			{"logout", "extra"}, {"logout", "--not-a-native-flag"},
			{"logout", "--model", "x"}, {"logout", "--", "extra"},
			{"--model", "--not-a-value", "logout"},
		} {
			if err := ValidateAuth(engine, args); err == nil {
				t.Errorf("%s accepted malformed auth %q", engine, args)
			}
		}
	}
	for _, tc := range []struct {
		engine string
		args   []string
	}{
		{"codex", []string{"logout"}}, {"codex", []string{"--model", "fixture", "logout"}},
		{"codex", []string{"--image=agents", "logout", "-c", "model='x'"}},
		{"codex", []string{"logout", "--enable", "fixture"}},
		{"codex", []string{"login", "--device-auth"}},
		{"codex", []string{"--model", "fixture", "login", "-c", "model='x'", "status"}},
		{"grok", []string{"--debug-file", "login", "logout", "--debug"}},
		{"grok", []string{"--model", "fixture", "logout"}},
		{"grok", []string{"--print", "logout", "login", "--device-code"}},
	} {
		if err := ValidateAuth(tc.engine, tc.args); err != nil {
			t.Errorf("%s valid auth %q: %v", tc.engine, tc.args, err)
		}
	}
}

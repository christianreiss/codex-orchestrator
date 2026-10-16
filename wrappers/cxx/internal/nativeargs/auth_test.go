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

func TestRetiredCodexAPIKeyAndConflictingSourcesFailBeforeLifecycle(t *testing.T) {
	for _, args := range [][]string{{"login", "--api-key"}, {"login", "--api-key", "fixture"}, {"login", "--api-key=fixture"}, {"login", "--with-api-key", "--with-access-token"}} {
		if err := ValidateAuth("codex", args); err == nil {
			t.Fatalf("rejected native auth entered managed lifecycle: %q", args)
		}
	}
	for _, args := range [][]string{{"login", "--with-api-key"}, {"login", "--with-access-token"}} {
		if err := ValidateAuth("codex", args); err != nil {
			t.Fatalf("supported source rejected: %q %v", args, err)
		}
	}
	args := []string{"login", "--api-key", "fixture", "status"}
	name, value, end := Option("codex", args, 1)
	if name != "--api-key" || value != "fixture" || end != 2 {
		t.Fatalf("retired optional grammar lost: %q %q %d", name, value, end)
	}
}

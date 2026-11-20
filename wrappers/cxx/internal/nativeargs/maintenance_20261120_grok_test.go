package nativeargs

import "testing"

// Grok Build 1.0.91+ declares -p/--single/--print as `[PROMPT]` (optional) and
// adds --system-prompt-file <PATH>. Only the safe superset is implemented: the
// optional form differs from the 1.0.89 required form only when the next token
// starts with `-`, which 1.0.89 rejected natively. The variadic prompt words and
// command-word semantics of 1.0.91+ are deliberately not modelled.
func TestGrokPromptFlagIsOptionalValued(t *testing.T) {
	for _, tc := range []struct {
		args  []string
		at    int
		name  string
		value string
		end   int
	}{
		{[]string{"-p", "--always-approve"}, 0, "--single", "", 0},
		{[]string{"-p", "--always-approve"}, 1, "--always-approve", "", 1},
		{[]string{"-p", "-m", "x"}, 0, "--single", "", 0},
		{[]string{"-p", "-m", "x"}, 1, "--model", "x", 2},
		{[]string{"--single", "--resume", "id"}, 0, "--single", "", 0},
		{[]string{"--print", "--rules", "r"}, 0, "--single", "", 0},
		{[]string{"-p", "-"}, 0, "--single", "-", 1},
		{[]string{"-p", "text"}, 0, "--single", "text", 1},
		{[]string{"--print", "text"}, 0, "--single", "text", 1},
		{[]string{"-p=text"}, 0, "--single", "text", 0},
		{[]string{"-ptext"}, 0, "--single", "text", 0},
		{[]string{"--single=--always-approve"}, 0, "--single", "--always-approve", 0},
		{[]string{"-p", "logout"}, 0, "--single", "logout", 1},
		{[]string{"-p", "--", "x"}, 0, "--single", "", 0},
	} {
		name, value, end := Option("grok", tc.args, tc.at)
		if name != tc.name || value != tc.value || end != tc.end {
			t.Fatalf("%q at %d: name=%q value=%q end=%d, want %q %q %d", tc.args, tc.at, name, value, end, tc.name, tc.value, tc.end)
		}
	}
	// The flag after a bare -p is visible to readers (the status banner needs it).
	if !Has("grok", []string{"-p", "--always-approve", "fix it"}, "--always-approve") {
		t.Fatal("--always-approve swallowed as the prompt value")
	}
	if !Has("grok", []string{"-p", "-m", "x"}, "--model") || Value("grok", []string{"-p", "-m", "x"}, "--model") != "x" {
		t.Fatal("-m after a bare -p lost")
	}
	// A word after -p stays the prompt, so it is never a command.
	for _, args := range [][]string{{"-p", "logout"}, {"--print", "login"}, {"--single", "update"}, {"-p", "worker"}} {
		if cmd, _ := Command("grok", args); cmd != "" {
			t.Fatalf("%q: prompt parsed as command %q", args, cmd)
		}
		if got := UnsupportedService("grok", args); got != "" {
			t.Fatalf("%q: prompt refused as %q", args, got)
		}
	}
	// `-p --always-approve login` still reaches the real login command.
	if cmd, at := Command("grok", []string{"-p", "--always-approve", "login"}); cmd != "login" || at != 2 {
		t.Fatalf("login after bare -p not identified: %q %d", cmd, at)
	}
	if err := ValidateAuth("grok", []string{"-p", "--always-approve", "login"}); err != nil {
		t.Fatalf("auth grammar after bare -p: %v", err)
	}
	if err := ValidateAuth("grok", []string{"-p", "logout"}); err != nil {
		t.Fatalf("prompt word logout rejected: %v", err)
	}
}

func TestGrokSystemPromptFileValueStaysOpaque(t *testing.T) {
	for _, value := range []string{"doctor", "login", "logout", "worker", "--always-approve", "--leader-socket", "update"} {
		args := []string{"--system-prompt-file", value}
		name, got, end := Option("grok", args, 0)
		if name != "--system-prompt-file" || got != value || end != 1 {
			t.Fatalf("%q: name=%q value=%q end=%d", args, name, got, end)
		}
		if cmd, _ := Command("grok", args); cmd != "" {
			t.Fatalf("%q: value parsed as command %q", args, cmd)
		}
		if Has("grok", args, value) && value != "" && value[0] == '-' {
			t.Fatalf("%q: value became an option", args)
		}
		if got := UnsupportedService("grok", args); got != "" {
			t.Fatalf("%q: value refused as %q", args, got)
		}
	}
	if name, value, end := Option("grok", []string{"--system-prompt-file=doctor"}, 0); name != "--system-prompt-file" || value != "doctor" || end != 0 {
		t.Fatalf("equals form: %q %q %d", name, value, end)
	}
	if err := ValidateAuth("grok", []string{"--system-prompt-file", "login", "login"}); err != nil {
		t.Fatalf("auth grammar with --system-prompt-file: %v", err)
	}
}

package claude

import (
	"strings"
	"testing"
)

// Claude Code 2.1.328/2.1.329 added six hidden required-value root options.
// A value spelled like a subcommand or service must stay a value: no subcommand
// index, no refused service, and --settings lands after the value, not between
// the option and its value.
func TestClaudeNativeRootValueOptions2329KeepValuesOpaque(t *testing.T) {
	for _, flag := range []string{
		"--fast-mode", "--metadata", "--lead-verify-key",
		"--session-began-as-copy", "--initialize-fields", "--runner-declares",
	} {
		if _, ok := claudeGlobalOptionsWithValue[flag]; !ok {
			t.Fatalf("%s missing from the required-value table", flag)
		}
	}
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"--metadata", "login", "--help"}, "--metadata login --help --settings managed.json"},
		{[]string{"--fast-mode", "attach", "p"}, "--fast-mode attach p --settings managed.json"},
		{[]string{"--runner-declares", "agents", "p"}, "--runner-declares agents p --settings managed.json"},
		{[]string{"--metadata", "attach", "x"}, "--metadata attach x --settings managed.json"},
		{[]string{"--lead-verify-key", "daemon", "p"}, "--lead-verify-key daemon p --settings managed.json"},
		{[]string{"--session-began-as-copy", "auth", "p"}, "--session-began-as-copy auth p --settings managed.json"},
		{[]string{"--initialize-fields", "rc", "p"}, "--initialize-fields rc p --settings managed.json"},
		// Flag-shaped values are consumed too, like every other required value.
		{[]string{"--metadata", "--help", "p"}, "--metadata --help p --settings managed.json"},
		{[]string{"--fast-mode", "on", "--", "attach"}, "--fast-mode on --settings managed.json -- attach"},
	} {
		if at, ok := NativeSubcommandIndex(tc.args); ok {
			t.Fatalf("%q: value became subcommand %q at %d", tc.args, tc.args[at], at)
		}
		if got := UnsupportedNativeService(tc.args); got != "" {
			t.Fatalf("%q: value refused as service %q", tc.args, got)
		}
		if isInteractiveAuthLogin(tc.args) {
			t.Fatalf("%q: value treated as interactive login", tc.args)
		}
		if got := strings.Join(injectRuntimeAuthSettings(tc.args, "managed.json"), " "); got != tc.want {
			t.Fatalf("%q: injected %q, want %q", tc.args, got, tc.want)
		}
	}
	// An equals-form value is part of the option; a real subcommand after it still counts.
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"--metadata=k=v", "login"}, "--metadata=k=v --settings managed.json login"},
		{[]string{"--fast-mode=on", "auth", "status"}, "--fast-mode=on --settings managed.json auth status"},
	} {
		at, ok := NativeSubcommandIndex(tc.args)
		if !ok || at != 1 {
			t.Fatalf("%q: subcommand index %d ok=%v", tc.args, at, ok)
		}
		if got := strings.Join(injectRuntimeAuthSettings(tc.args, "managed.json"), " "); got != tc.want {
			t.Fatalf("%q: injected %q, want %q", tc.args, got, tc.want)
		}
	}
	// A real service after the value is still refused.
	if got := UnsupportedNativeService([]string{"--metadata", "k=v", "attach", "x"}); got != "attach" {
		t.Fatalf("service hidden behind a value: %q", got)
	}
	if !isInteractiveAuthLogin([]string{"--fast-mode", "on", "login"}) {
		t.Fatal("interactive login after a value not detected")
	}
}

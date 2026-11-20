package nativeargs

import (
	"reflect"
	"testing"
)

// Kimi Code 2.7.x made `server` a hidden full-option command (children
// rotate-token, kill and hidden ensure-daemon), gave `web`/`server` --json and
// added the hidden `install-app` command.
func TestKimi272ServerAndWebGrammar(t *testing.T) {
	for _, tc := range []struct {
		args []string
		at   int
		name string
		end  int
	}{
		{[]string{"server", "--host", "--json"}, 1, "--host", 1},
		{[]string{"server", "--host", "0.0.0.0", "--json"}, 1, "--host", 2},
		{[]string{"server", "--port", "1", "--allowed-host", "a", "b"}, 1, "--port", 2},
		{[]string{"server", "--port", "1", "--allowed-host", "a", "b"}, 3, "--allowed-host", 5},
		{[]string{"server", "--web-title", "--json"}, 1, "--web-title", 2},
		{[]string{"server", "--log-level", "--open"}, 1, "--log-level", 2},
		{[]string{"server", "--remote-control"}, 1, "--rc", 1},
		{[]string{"server", "--open"}, 1, "--open", 1},
		{[]string{"server", "--insecure-no-tls", "--allow-remote-shutdown"}, 1, "--insecure-no-tls", 1},
		{[]string{"web", "--json"}, 1, "--json", 1},
		{[]string{"web", "--json", "--port", "1"}, 2, "--port", 3},
		{[]string{"server", "ensure-daemon", "--probe"}, 2, "--probe", 2},
	} {
		name, _, end := Option("kimi", tc.args, tc.at)
		if name != tc.name || end != tc.end {
			t.Fatalf("%q at %d: name=%q end=%d, want %q end=%d", tc.args, tc.at, name, end, tc.name, tc.end)
		}
	}
	// `--host` is optional: a following flag is not its value, a plain word is.
	if _, value, _ := Option("kimi", []string{"server", "--host", "--json"}, 1); value != "" {
		t.Fatalf("--json consumed as host value: %q", value)
	}
	if _, value, _ := Option("kimi", []string{"server", "--host", "example.test"}, 1); value != "example.test" {
		t.Fatalf("host value lost: %q", value)
	}
	// Variadic --allowed-host stops at the next option.
	args := []string{"server", "--allowed-host", "a", "b", "--json"}
	if _, value, end := Option("kimi", args, 1); value != "a" || end != 3 {
		t.Fatalf("allowed-host: value=%q end=%d", value, end)
	}
	if !Has("kimi", args, "--json") {
		t.Fatal("--json after a variadic value was swallowed")
	}
}

func TestKimi272ServerChildrenScopeTheirOptions(t *testing.T) {
	// Under `server rotate-token`/`kill` only --help exists, so a server option
	// is no longer recognized there; before the child it is.
	for _, tc := range []struct {
		args []string
		at   int
		want string
		end  int
	}{
		{[]string{"server", "rotate-token", "--help"}, 2, "--help", 2},
		{[]string{"server", "kill", "-h"}, 2, "--help", 2},
		{[]string{"server", "ensure-daemon", "--probe", "--help"}, 3, "--help", 3},
		{[]string{"install-app", "--help"}, 1, "--help", 1},
		{[]string{"web", "rotate-token", "--help"}, 2, "--help", 2},
	} {
		name, _, end := Option("kimi", tc.args, tc.at)
		if name != tc.want || end != tc.end {
			t.Fatalf("%q at %d: name=%q end=%d", tc.args, tc.at, name, end)
		}
	}
	for _, tc := range []struct {
		args []string
		path string
	}{
		{[]string{"server", "rotate-token"}, "server rotate-token"},
		{[]string{"server", "kill"}, "server kill"},
		{[]string{"server", "ensure-daemon", "--probe"}, "server ensure-daemon"},
		// An option value spelled like a child does not select the child scope.
		{[]string{"server", "--web-title", "rotate-token", "--port", "1"}, "server"},
		{[]string{"server", "--log-level", "ensure-daemon", "--port", "1"}, "server"},
	} {
		want := kimiTable(tc.path)
		got := kimiOptionTable(append(append([]string{}, tc.args...), "--x"), len(tc.args))
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%q: wrong option scope, want %q", tc.args, tc.path)
		}
	}
	if name, value, end := Option("kimi", []string{"server", "--web-title", "kill", "--port", "1"}, 3); name != "--port" || value != "1" || end != 4 {
		t.Fatalf("value spelled kill changed the scope: %q %q %d", name, value, end)
	}
}

func TestKimi272ServerLifecycleStaysRefusedAndValuesStayOpaque(t *testing.T) {
	for _, args := range [][]string{
		{"server"},
		{"server", "rotate-token"},
		{"server", "ensure-daemon", "--probe"},
		{"server", "--host", "--json"},
		{"server", "--port", "1", "--allowed-host", "a", "b"},
		{"web", "--json"},
	} {
		if got := UnsupportedService("kimi", args); got != args[0] {
			t.Fatalf("%q: refusal %q, want %q", args, got, args[0])
		}
	}
	for _, args := range [][]string{
		{"-p", "server"},
		{"--model", "server"},
		{"-m", "web"},
		{"--agent", "server"},
		{"--skills-dir", "server"},
		{"export", "--output", "server"},
		{"provider", "catalog", "list", "--filter", "server"},
		{"--", "server"},
	} {
		if got := UnsupportedService("kimi", args); got != "" {
			t.Fatalf("%q: opaque data refused as %q", args, got)
		}
	}
	// A server-scope value spelled like a command stays a value under web/server.
	for _, args := range [][]string{
		{"web", "--web-title", "server"},
		{"server", "--web-title", "server"},
		{"rc", "--web-title", "server"},
	} {
		name, value, end := Option("kimi", args, 1)
		if name != "--web-title" || value != "server" || end != 2 {
			t.Fatalf("%q: name=%q value=%q end=%d", args, name, value, end)
		}
		// The command word is the first token, never the option value.
		if _, at := Command("kimi", args); at != 0 {
			t.Fatalf("%q: value became the command (index %d)", args, at)
		}
	}
	if cmd, at := Command("kimi", []string{"install-app"}); cmd != "install-app" || at != 0 {
		t.Fatalf("install-app not identified: %q %d", cmd, at)
	}
	if cmd, _ := Command("kimi", []string{"-p", "install-app"}); cmd != "" {
		t.Fatalf("prompt parsed as install-app: %q", cmd)
	}
}

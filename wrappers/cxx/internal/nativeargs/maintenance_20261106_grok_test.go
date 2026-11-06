package nativeargs

import (
	"strings"
	"testing"
)

// grok1077WorkerOptions are the value-taking option lines Grok Build 1.0.77
// added to `[leader] worker [start|status|stop|controller] --help` (verified
// 2026-11-06 in a throwaway HOME/GROK_HOME). The rest of the 1.0.77 help still
// matches the pinned 1.0.70 corpus.
const grok1077WorkerOptions = `
      --mcp-tool-timeout <SERVER[/TOOL]=SECONDS>
      --data-dir <DIR>
      --wait [<SECONDS>]`

const grok1077ControllerOptions = grok1077WorkerOptions + `
      --warm-idle <COUNT>`

func TestGrok1077WorkerValueOptions(t *testing.T) {
	for _, prefix := range []string{"worker", "leader worker"} {
		for _, sub := range []string{"", "start", "status", "stop", "controller"} {
			path := strings.Fields(prefix + " " + sub)
			help := grok1077WorkerOptions
			if sub == "controller" {
				help = grok1077ControllerOptions
			}
			assertGrokHelpValues(t, path, help)
		}
	}
	for _, tc := range []struct {
		args        []string
		at          int
		name, value string
		end         int
	}{
		{[]string{"worker", "start", "--wait"}, 2, "--wait", "", 2},
		{[]string{"worker", "start", "--wait", "--json"}, 2, "--wait", "", 2},
		{[]string{"worker", "start", "--wait=30"}, 2, "--wait", "30", 2},
		{[]string{"worker", "status", "--wait", "30", "--json"}, 2, "--wait", "30", 3},
		{[]string{"worker", "controller", "--warm-idle", "--help"}, 2, "--warm-idle", "--help", 3},
		{[]string{"leader", "worker", "stop", "--mcp-tool-timeout", "srv/tool=5"}, 3, "--mcp-tool-timeout", "srv/tool=5", 4},
	} {
		name, value, end := Option("grok", tc.args, tc.at)
		if name != tc.name || value != tc.value || end != tc.end {
			t.Errorf("%q => %s %q %d", tc.args, name, value, end)
		}
	}
}

// Worker commands are refused by command word; the new option values stay data
// (`--data-dir worker` is a directory, not a command) and help still passes.
func TestGrok1077WorkerRefusalAndHelpUnchanged(t *testing.T) {
	for _, tc := range []struct {
		args    []string
		service string
	}{
		{[]string{"worker", "start", "--data-dir", "worker"}, "worker"},
		{[]string{"worker", "--data-dir", "worker", "status"}, "worker"},
		{[]string{"worker", "--wait", "worker", "start"}, "worker"},
		{[]string{"leader", "worker", "start", "--data-dir", "worker"}, "leader worker"},
		{[]string{"leader", "worker", "--data-dir", "worker", "stop"}, "leader worker"},
		{[]string{"leader", "worker", "--mcp-tool-timeout", "leader", "status"}, "leader worker"},
		{[]string{"leader", "worker", "controller", "--warm-idle", "worker", "--spawn", "hook"}, "leader worker"},
		{[]string{"leader", "list"}, ""},
	} {
		if got := UnsupportedService("grok", tc.args); got != tc.service {
			t.Errorf("%q service %q want %q", tc.args, got, tc.service)
		}
	}
	if got := Value("grok", []string{"worker", "start", "--data-dir", "worker"}, "--data-dir"); got != "worker" {
		t.Fatalf("--data-dir value %q", got)
	}
	for _, tc := range []struct {
		args []string
		help bool
	}{
		{[]string{"worker", "start", "--data-dir", "d", "--help"}, true},
		{[]string{"leader", "worker", "controller", "--warm-idle", "2", "--help"}, true},
		{[]string{"worker", "start", "--wait", "--help"}, true},
		{[]string{"worker", "start", "--data-dir", "--help"}, false},
		{[]string{"worker", "--mcp-tool-timeout", "--help"}, false},
		{[]string{"leader", "worker", "controller", "--warm-idle", "--help"}, false},
		{[]string{"worker", "status", "--wait", "5", "--help"}, true},
	} {
		if got := Has("grok", tc.args, "--help"); got != tc.help {
			t.Errorf("%q help %v want %v", tc.args, got, tc.help)
		}
	}
}

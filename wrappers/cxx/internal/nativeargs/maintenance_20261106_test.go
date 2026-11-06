package nativeargs

import "testing"

// Codex 0.167.0 adds the boolean `agents --no-daemon`, which runs the agents
// overview against an embedded app server instead of the shared daemon. That
// in-process server bypasses the wrapper-owned private app-server, auth broker
// and receiver just like the daemon path, so every form stays refused.
func TestCodexAgentsNoDaemonStaysRefused(t *testing.T) {
	for _, args := range [][]string{
		{"agents", "--no-daemon"},
		{"agents", "--no-daemon", "--remote", "x"},
		{"agents", "--remote", "x", "--no-daemon"},
		{"--no-daemon", "agents"},
		{"--model", "m", "agents", "--no-daemon"},
	} {
		if got := UnsupportedService("codex", args); got != "agents" {
			t.Errorf("%q service %q want agents", args, got)
		}
	}
	// --no-daemon is zero-arity: it never consumes the following token.
	args := []string{"agents", "--no-daemon", "--remote", "x"}
	if !Has("codex", args, "--no-daemon") || Value("codex", args, "--remote") != "x" {
		t.Fatalf("--no-daemon consumed a value: %q", args)
	}
	if end := ValueEnd("codex", args, 1); end != 1 {
		t.Fatalf("--no-daemon end %d want 1", end)
	}
	// Values spelled like the flag remain data.
	for _, args := range [][]string{{"--model", "--no-daemon"}, {"queue", "--message", "--no-daemon"}} {
		if Has("codex", args, "--no-daemon") {
			t.Errorf("value became --no-daemon: %q", args)
		}
	}
}

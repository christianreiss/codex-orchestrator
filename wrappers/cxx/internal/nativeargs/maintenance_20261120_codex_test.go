package nativeargs

import "testing"

// Codex 0.171 added --remote/--remote-auth-token-env to every exec scope and
// exec-server [forward] --tcp-upstream-proxy <HOST:PORT>.
func TestCodex0171TCPUpstreamProxyKeepsFlagShapedValues(t *testing.T) {
	for _, tc := range []struct {
		args []string
		at   int
	}{
		{[]string{"exec-server", "--tcp-upstream-proxy", "--auto"}, 1},
		{[]string{"exec-server", "--tcp-upstream-proxy", "login"}, 1},
		{[]string{"exec-server", "forward", "--tcp-upstream-proxy", "--remote"}, 2},
		{[]string{"exec-server", "forward", "--tcp-upstream-proxy", "exec"}, 2},
	} {
		name, value, end := Option("codex", tc.args, tc.at)
		if name != "--tcp-upstream-proxy" || value != tc.args[tc.at+1] || end != tc.at+1 {
			t.Fatalf("%q: name=%q value=%q end=%d", tc.args, name, value, end)
		}
		if Has("codex", tc.args, tc.args[tc.at+1]) {
			t.Fatalf("%q: value became an option", tc.args)
		}
	}
	// The value hides neither the refused command nor a later real --remote.
	if got := UnsupportedService("codex", []string{"exec-server", "--tcp-upstream-proxy", "login"}); got != "exec-server" {
		t.Fatalf("exec-server escaped refusal: %q", got)
	}
	if got := UnsupportedService("codex", []string{"-m", "x", "--tcp-upstream-proxy", "--auto"}); got != "" {
		t.Fatalf("opaque value refused: %q", got)
	}
}

func TestCodex0171ExecRemoteIsRefusedButValuesStayData(t *testing.T) {
	for _, args := range [][]string{
		{"exec", "--remote", "ws://127.0.0.1:1", "prompt"},
		{"exec", "resume", "--remote", "ws://127.0.0.1:1", "--last"},
		{"exec", "fork", "--remote", "ws://127.0.0.1:1", "--last"},
		{"exec", "review", "--remote", "ws://127.0.0.1:1", "--uncommitted"},
		{"exec", "--remote=ws://127.0.0.1:1", "prompt"},
		{"exec", "review", "--remote-auth-token-env", "TOKEN", "--remote", "ws://x"},
	} {
		if got := UnsupportedService("codex", args); got != "--remote" {
			t.Fatalf("%q: refusal %q", args, got)
		}
	}
	for _, args := range [][]string{
		{"exec", "-m", "--remote", "prompt"},
		{"exec", "resume", "-m", "--remote", "--last"},
		{"exec", "fork", "--thread-source", "--remote", "--last"},
		{"exec", "review", "--title", "--remote", "--uncommitted"},
		{"exec", "--remote-auth-token-env", "--remote", "prompt"},
		{"exec", "--", "--remote"},
	} {
		if got := UnsupportedService("codex", args); got != "" {
			t.Fatalf("%q: opaque data refused as %q", args, got)
		}
	}
}

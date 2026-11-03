package codex

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestNonInteractiveCommandsKeepDirectTransportOnATerminal(t *testing.T) {
	// The caller may have TTY stdin/stdout even for cdx --execute. These
	// commands cannot attach the TUI's --remote transport or start its server.
	t.Setenv("CXX_AGENT_PORTAL_SOCKET", "")
	for _, args := range [][]string{
		{"exec", "--", "prompt"},
		{"e", "prompt"},
		{"review", "--uncommitted"},
		{"--model", "fixture", "exec", "resume", "native-id", "prompt"},
		{"--config", "fixture=1", "exec", "fork", "native-id"},
	} {
		got, cleanup, err := startReceiverServer(context.Background(), "must-not-start", args, nil, nil, nil)
		if err != nil || !reflect.DeepEqual(got, args) {
			t.Fatalf("non-interactive %q acquired TUI transport: args=%q err=%v", args, got, err)
		}
		cleanup()
	}
	for _, args := range [][]string{
		nil, {"resume", "native-id"}, {"fork", "native-id"},
		{"--model", "exec"}, {"--", "exec"}, {"--image", "exec", "resume"},
	} {
		_, _, err := startReceiverServer(context.Background(), "must-not-start", args, nil, nil, nil)
		if err == nil || !strings.Contains(err.Error(), "private broker unavailable") {
			t.Fatalf("TUI %q did not retain receiver requirements: %v", args, err)
		}
	}
}

func TestReceiverCleanupTerminatesServerAndItsDescendant(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("CODEX_HOME", filepath.Join(dir, ".codex"))
	session, err := AcquireAuthSession()
	if err != nil {
		t.Fatal(err)
	}
	defer FinishAuthSession(session)
	lease, err := AcquireActiveChild()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	t.Setenv("CXX_AGENT_PORTAL_SOCKET", filepath.Join(dir, "broker.sock"))
	t.Setenv("CXX_TEST_RECEIVER_DIR", dir)
	path := filepath.Join(dir, "native")
	script := `#!/bin/sh
case "$1" in
child)
 trap 'echo caught > "$CXX_TEST_RECEIVER_DIR/child-stopped"; exit 0' TERM
 : > "$CXX_TEST_RECEIVER_DIR/child-ready"
 while :; do sleep 0.02; done
 ;;
*)
 printf '%s\n' "$@" > "$CXX_TEST_RECEIVER_DIR/argv"
 "$0" child &
 child=$!
 trap 'wait "$child"; echo caught > "$CXX_TEST_RECEIVER_DIR/server-stopped"; exit 0' TERM
 while [ ! -e "$CXX_TEST_RECEIVER_DIR/child-ready" ]; do sleep 0.01; done
 : > "$CXX_TEST_RECEIVER_DIR/codex.sock"
 wait "$child"
 ;;
esac
`
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	args, cleanup, err := startReceiverServer(context.Background(), path, []string{"--model", "--remote", "--image", "a.png", "login", "-cfixture=1", "--config=next=2", "--", "-cliteral=3"}, os.Environ(), session, lease)
	if err != nil {
		t.Fatal(err)
	}
	captured, readErr := os.ReadFile(filepath.Join(dir, "argv"))
	if readErr != nil || !strings.Contains(string(captured), "-c\nfixture=1\n-c\nnext=2\n") || strings.Contains(string(captured), "literal=3") || strings.Contains(string(captured), "login") {
		cleanup()
		t.Fatalf("receiver config extraction: %s %v", captured, readErr)
	}
	if len(args) < 2 || args[0] != "--remote" {
		t.Fatalf("remote args: %v", args)
	}
	done := make(chan struct{})
	go func() { cleanup(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("receiver cleanup did not finish")
	}
	for _, name := range []string{"child-stopped", "server-stopped"} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || !strings.Contains(string(data), "caught") {
			t.Fatalf("%s handler did not finish: %q %v", name, data, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "codex.sock")); !os.IsNotExist(err) {
		t.Fatalf("receiver socket remained: %v", err)
	}
}

func TestReceiverMCPCommandUsesCxxForPersonaAlias(t *testing.T) {
	bin := t.TempDir()
	canonical := filepath.Join(bin, "cxx")
	if err := os.WriteFile(canonical, []byte("cxx"), 0o755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(bin, "cdx")
	if err := os.Symlink("cxx", alias); err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(canonical)
	if err != nil {
		t.Fatal(err)
	}
	prior := selfExecutable
	selfExecutable = func() (string, error) { return alias, nil } // macOS keeps the alias
	t.Cleanup(func() { selfExecutable = prior })
	got, err := receiverMCPOverrides("/run/codex.sock")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(got, " ")
	if !strings.Contains(joined, "mcp_servers.cxx-agent.command="+strconv.Quote(want)) || strings.Contains(joined, alias) {
		t.Fatalf("MCP command must name cxx, not the cdx alias: %v", got)
	}
}

package codex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

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
	args, cleanup, err := startReceiverServer(context.Background(), path, nil, os.Environ(), session, lease)
	if err != nil {
		t.Fatal(err)
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

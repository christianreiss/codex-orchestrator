package communicator

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// sun_path is 108 bytes on Linux (104 on the BSDs). An oversized runtime root
// used to make the owner fail to bind and every managed call report only
// "communicator failed to start".
func TestSocketPathStaysBindableWhenRuntimeRootIsTooLong(t *testing.T) {
	long := filepath.Join(t.TempDir(), strings.Repeat("d", 60), strings.Repeat("e", 60))
	if err := os.MkdirAll(long, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_RUNTIME_DIR", long)
	base := fmt.Sprintf("https://socket-length.%d.example", time.Now().UnixNano())
	path, err := socketPath(base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(filepath.Dir(path)) })
	if len(path) > maxSocketPath {
		t.Fatalf("socket path is %d bytes (limit %d): %s", len(path), maxSocketPath, path)
	}
	info, err := os.Stat(filepath.Dir(path))
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("socket directory must be private: %v %v", info, err)
	}
	again, err := socketPath(base)
	if err != nil || again != path {
		t.Fatalf("path must be stable for every process: %q vs %q (%v)", again, path, err)
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("bind %s: %v", path, err)
	}
	listener.Close()
}

func TestSocketPathPrefersTheRuntimeRootWhenItFits(t *testing.T) {
	root, err := os.MkdirTemp("", "cc-fit-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	t.Setenv("XDG_RUNTIME_DIR", root)
	path, err := socketPath("https://socket-fit.example")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(path, root+string(filepath.Separator)) {
		t.Fatalf("expected %s under %s", path, root)
	}
}

// A child that dies while starting must be reported with its own message right
// away, not after the ten second wait and without the cause.
func TestEnsureReportsStartupFailureFast(t *testing.T) {
	root, err := os.MkdirTemp("", "cc-fail-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	t.Setenv("XDG_RUNTIME_DIR", root)
	script := filepath.Join(root, "fake-cxx")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho 'listen unix: bind: boom' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	previous := executable
	executable = func() (string, error) { return script, nil }
	t.Cleanup(func() { executable = previous })
	socket, err := socketPath("https://startup-failure.example")
	if err != nil {
		t.Fatal(err)
	}
	ep := &endpoint{base: "https://startup-failure.example", path: filepath.Join(root, "cfg.json"), socket: socket}
	started := time.Now()
	err = ep.ensure(t.Context())
	if err == nil || !strings.Contains(err.Error(), "bind: boom") {
		t.Fatalf("expected the child's own error, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("a dead child must not be waited on for the full deadline (%s)", elapsed)
	}
}

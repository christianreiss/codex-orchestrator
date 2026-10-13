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
	if len(path) > socketPathLimit() {
		t.Fatalf("socket path is %d bytes (limit %d): %s", len(path), socketPathLimit(), path)
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

// Two isolated scopes that are both too deep to bind must never meet: the fallback
// directory is keyed by the resolved scope as well as by the server, or one harness
// (or a user's test run) would attach to another's owner, fences and credentials.
func TestLongScopesFallBackToDistinctSockets(t *testing.T) {
	base := fmt.Sprintf("https://scope-isolation.%d.example", time.Now().UnixNano())
	longScope := func(tag string) string {
		dir := filepath.Join(t.TempDir(), strings.Repeat(tag, 40), strings.Repeat(tag, 40))
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	resolve := func(root string) string {
		t.Setenv("XDG_RUNTIME_DIR", root)
		path, err := socketPath(base)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(filepath.Dir(path)) })
		if len(path) > socketPathLimit() {
			t.Fatalf("%d bytes over the %d limit: %s", len(path), socketPathLimit(), path)
		}
		return path
	}
	a, b := resolve(longScope("a")), resolve(longScope("b"))
	if a == b {
		t.Fatalf("two different isolated scopes share %s", a)
	}
	t.Setenv("XDG_RUNTIME_DIR", "")
	root := longScope("a")
	t.Setenv("XDG_RUNTIME_DIR", root)
	if again, err := socketPath(base); err != nil || again != resolve(root) {
		t.Fatalf("one scope must always map to one socket: %q %v", again, err)
	}
	// Nor may a long scope land where the ordinary short default scope's owner lives.
	shortDefault, err := socketPathIn(filepath.Join("/tmp", fmt.Sprintf("cxx-%d", os.Getuid())), base, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(filepath.Dir(shortDefault)) })
	if a == shortDefault || b == shortDefault {
		t.Fatalf("a long isolated scope attached to the default short scope: %s", shortDefault)
	}
}

// The limit is the platform's own, not a conservative guess, so a path that binds on
// this platform keeps its preferred location (and so keeps meeting older owners there).
func TestSocketLimitBoundaryUsesThePlatformLimit(t *testing.T) {
	base := fmt.Sprintf("https://scope-boundary.%d.example", time.Now().UnixNano())
	fixed := len(filepath.Join("/", "cxx-comm-0123456789abcdef", "control.sock")) // bytes the socket adds to the root
	parent, err := os.MkdirTemp("", "cc-lim-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(parent) })
	rootWithPathLen := func(total int) string {
		name := total - fixed - len(parent) - 1
		if name < 1 {
			t.Skipf("temp parent %q too long to place the boundary", parent)
		}
		root := filepath.Join(parent, strings.Repeat("r", name))
		if err := os.MkdirAll(root, 0700); err != nil {
			t.Fatal(err)
		}
		return root
	}
	atLimit := rootWithPathLen(socketPathLimit())
	t.Setenv("XDG_RUNTIME_DIR", atLimit)
	path, err := socketPath(base)
	if err != nil || !strings.HasPrefix(path, atLimit+string(filepath.Separator)) || len(path) != socketPathLimit() {
		t.Fatalf("a path exactly at the limit keeps its place: %q (%v)", path, err)
	}
	over := rootWithPathLen(socketPathLimit() + 1)
	t.Setenv("XDG_RUNTIME_DIR", over)
	fallback, err := socketPath(base)
	t.Cleanup(func() { os.RemoveAll(filepath.Dir(fallback)) })
	if err != nil || strings.HasPrefix(fallback, over+string(filepath.Separator)) || len(fallback) > socketPathLimit() {
		t.Fatalf("one byte over must fall back: %q (%v)", fallback, err)
	}
}

// With no XDG scope at all, an oversized TMPDIR must not strand the owner either.
func TestLongTmpdirWithoutAnXDGScopeStillBinds(t *testing.T) {
	previous := sessionRuntimeRoot
	sessionRuntimeRoot = func() string { return "/nonexistent-logind-root" }
	t.Cleanup(func() { sessionRuntimeRoot = previous })
	t.Setenv("XDG_RUNTIME_DIR", "")
	long := filepath.Join(t.TempDir(), strings.Repeat("t", 70), strings.Repeat("u", 70))
	if err := os.MkdirAll(long, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", long)
	path, err := socketPath(fmt.Sprintf("https://long-tmpdir.%d.example", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(filepath.Dir(path)) })
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("bind %s: %v", path, err)
	}
	listener.Close()
}

func TestStartupDiagnosticIsBoundedAndPrintable(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "serve.log")
	noisy := "listen unix: bind: boom\x1b[31mred\x1b[0m\x07\r\n" + strings.Repeat("A", 5000)
	if err := os.WriteFile(log, []byte(noisy), 0600); err != nil {
		t.Fatal(err)
	}
	got := serveLogTail(log, 0)
	if len(got) > 400 {
		t.Fatalf("unbounded: %d bytes", len(got))
	}
	for _, r := range got {
		if r < 0x20 || r == 0x7f {
			t.Fatalf("control character %q survived in %q", r, got)
		}
	}
	short := filepath.Join(dir, "short.log")
	if err := os.WriteFile(short, []byte("listen unix: bind: boom\x1b[31mred\x1b[0m\x07"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := serveLogTail(short, 0); strings.ContainsAny(got, "\x1b\x07") || !strings.Contains(got, "bind: boom") {
		t.Fatalf("sanitised tail lost or kept the wrong bytes: %q", got)
	}
}

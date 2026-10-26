package communicator

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// relocationRoots returns two private runtime roots and a server base unique to
// this test, so no real owner record or socket can answer.
func relocationRoots(t *testing.T, tag string) (string, string, string) {
	t.Helper()
	mk := func(suffix string) string {
		dir, err := os.MkdirTemp("", "cc-"+tag+"-"+suffix+"-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
		return dir
	}
	return mk("old"), mk("new"), fmt.Sprintf("https://relocate-%s.%d.example", tag, time.Now().UnixNano())
}

func failIfSpawned(t *testing.T, root string) {
	t.Helper()
	script := filepath.Join(root, "fake-cxx")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho 'spawned instead of following the moved owner' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	previous := executable
	executable = func() (string, error) { return script, nil }
	t.Cleanup(func() { executable = previous })
}

// Feedback 93b054f5: an owner replaced at another runtime root (/tmp/cxx-0 ->
// /run/user/0) must be found by a process that resolved the old path at start,
// and its managed requests must reach it without a restart.
func TestManagedRequestFollowsAnOwnerThatMovedRoots(t *testing.T) {
	oldRoot, newRoot, base := relocationRoots(t, "moved")
	t.Setenv("XDG_RUNTIME_DIR", oldRoot)
	stale, err := socketPath(base)
	if err != nil {
		t.Fatal(err)
	}
	registry.Store(base, &endpoint{base: base, path: filepath.Join(oldRoot, "cfg.json"), socket: stale})
	t.Cleanup(func() { registry.Delete(base) })

	t.Setenv("XDG_RUNTIME_DIR", newRoot)
	moved, err := socketPath(base)
	if err != nil {
		t.Fatal(err)
	}
	if moved == stale {
		t.Fatalf("roots must resolve to different sockets: %s", moved)
	}
	listener, err := net.Listen("unix", moved)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"ok":"`+r.URL.Path+`"}`)
	})}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	failIfSpawned(t, newRoot)

	direct := roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("must not go direct") })
	client := &http.Client{Transport: &Transport{Direct: direct}}
	response, err := client.Post(base+"/host/agent-sessions/s1/agent-messaging/list", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("managed request after relocation: %v", err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(string(body), "agent-messaging/list") {
		t.Fatalf("unexpected answer %d %s", response.StatusCode, body)
	}
	if got := endpointFor(base).localSocket(); got != moved {
		t.Fatalf("endpoint still names %s, want %s", got, moved)
	}
}

// When the old owner is gone and nothing listens yet, the replacement it starts
// binds at the freshly resolved path; ensure must wait there, not on the old one.
func TestEnsureWaitsForAReplacementAtTheResolvedPath(t *testing.T) {
	oldRoot, newRoot, base := relocationRoots(t, "replace")
	t.Setenv("XDG_RUNTIME_DIR", oldRoot)
	stale, err := socketPath(base)
	if err != nil {
		t.Fatal(err)
	}
	ep := &endpoint{base: base, path: filepath.Join(oldRoot, "cfg.json"), socket: stale}
	t.Setenv("XDG_RUNTIME_DIR", newRoot)
	moved, err := socketPath(base)
	if err != nil {
		t.Fatal(err)
	}
	// A clean child exit means another owner holds the lock and is still binding.
	script := filepath.Join(newRoot, "fake-cxx")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s' \"$$\" > \"$0.pid\"\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	previous := executable
	executable = func() (string, error) { return script, nil }
	t.Cleanup(func() { executable = previous })
	bound := make(chan net.Listener, 1)
	go func() {
		time.Sleep(200 * time.Millisecond)
		if listener, err := net.Listen("unix", moved); err == nil {
			bound <- listener
		}
		close(bound)
	}()
	t.Cleanup(func() {
		if listener, ok := <-bound; ok {
			listener.Close()
		}
	})
	started := time.Now()
	if err := ep.ensure(t.Context()); err != nil {
		t.Fatalf("ensure after relocation: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("ensure waited %s for a socket it could not see", elapsed)
	}
	if ep.localSocket() != moved {
		t.Fatalf("endpoint names %s, want %s", ep.localSocket(), moved)
	}
	rawPID, err := os.ReadFile(script + ".pid")
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(string(rawPID))
	if err != nil {
		t.Fatal(err)
	}
	if _, recorded := ep.startedPIDs[pid]; !recorded {
		t.Fatal("spawned owner candidate is missing from launch statistics")
	}
}

// An unchanged location keeps the existing start path (and its error).
func TestEnsureDoesNotRelocateWhenThePathIsUnchanged(t *testing.T) {
	root, _, base := relocationRoots(t, "same")
	t.Setenv("XDG_RUNTIME_DIR", root)
	socket, err := socketPath(base)
	if err != nil {
		t.Fatal(err)
	}
	failIfSpawned(t, root)
	ep := &endpoint{base: base, path: filepath.Join(root, "cfg.json"), socket: socket}
	if ep.relocate(t.Context()) {
		t.Fatal("relocate reported a change for the same path")
	}
	if err := ep.ensure(t.Context()); err == nil || !strings.Contains(err.Error(), "spawned instead") {
		t.Fatalf("expected the start attempt's own error, got %v", err)
	}
}

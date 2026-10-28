package communicator

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

// sweepRoot is a private stand-in for /run/user/$UID; tests never sweep a real root.
func sweepRoot(t *testing.T) string {
	t.Helper()
	// Short, so a control.sock inside still fits sun_path.
	parent, err := os.MkdirTemp("", "cs-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(parent) })
	root := filepath.Join(parent, "run")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	return root
}

// commDir creates cxx-comm-<n> with the given files and backdates everything by age.
func commDir(t *testing.T, root string, n int, age time.Duration, files ...string) string {
	t.Helper()
	dir := filepath.Join(root, fmt.Sprintf("%s%016x", socketDirPrefix, n))
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range files {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	backdate(t, dir, age)
	return dir
}

func backdate(t *testing.T, dir string, age time.Duration) {
	t.Helper()
	when := time.Now().Add(-age)
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		_ = os.Chtimes(filepath.Join(dir, entry.Name()), when, when)
	}
	if err := os.Chtimes(dir, when, when); err != nil {
		t.Fatal(err)
	}
}

func exists(path string) bool { _, err := os.Lstat(path); return err == nil }

// Feedback 3e2df8d1: 558 cxx-comm-* directories under /run/user/1000, each
// holding only an idle sync lock, were never removed. Abandoned ones go; a
// directory anybody may still be using stays.
func TestRuntimeSweepRemovesOnlyAbandonedDirectories(t *testing.T) {
	root := sweepRoot(t)
	abandoned := commDir(t, root, 1, 2*time.Hour, "sync-a.lock", "auth-b.lock", "serve.log")
	young := commDir(t, root, 2, time.Minute, "sync-a.lock")
	owned := commDir(t, root, 3, 2*time.Hour, "owner.lock", "sync-a.lock")
	fenced := commDir(t, root, 4, 2*time.Hour, "sync-a.lock")
	unknown := commDir(t, root, 5, 2*time.Hour, "sync-a.lock")
	if err := os.Mkdir(filepath.Join(unknown, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	backdate(t, unknown, 2*time.Hour)
	listening := commDir(t, root, 6, 2*time.Hour)
	listener, err := net.Listen("unix", filepath.Join(listening, "control.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	backdate(t, listening, 2*time.Hour)
	crashed := commDir(t, root, 7, 2*time.Hour, "owner.lock")
	dead, err := net.Listen("unix", filepath.Join(crashed, "control.sock"))
	if err != nil {
		t.Fatal(err)
	}
	dead.(*net.UnixListener).SetUnlinkOnClose(false)
	dead.Close()
	backdate(t, crashed, 2*time.Hour)

	ownerLock, err := ipc.TryAcquireExclusivePath(filepath.Join(owned, "owner.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer ownerLock.Release()
	fence, err := ipc.TryAcquireExclusivePath(filepath.Join(fenced, "sync-a.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer fence.Release()

	// Things the sweep must never touch however old they are.
	foreign := filepath.Join(root, "cxx-comm-notahexname00000")
	if err := os.Mkdir(foreign, 0700); err != nil {
		t.Fatal(err)
	}
	backdate(t, foreign, 2*time.Hour)
	target := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(root, fmt.Sprintf("%s%016x", socketDirPrefix, 8))
	if err := os.Symlink(target, linked); err != nil {
		t.Fatal(err)
	}
	loose := filepath.Join(root, fmt.Sprintf("%s%016x", socketDirPrefix, 9))
	if err := os.Mkdir(loose, 0755); err != nil {
		t.Fatal(err)
	}
	backdate(t, loose, 2*time.Hour)

	if removed := sweepRuntimeRoot(root, time.Now()); removed != 2 {
		t.Fatalf("removed %d directories, want 2", removed)
	}
	for _, gone := range []string{abandoned, crashed} {
		if exists(gone) {
			t.Fatalf("abandoned %s survived", gone)
		}
	}
	for _, kept := range []string{young, owned, fenced, unknown, listening, foreign, linked, target, loose} {
		if !exists(kept) {
			t.Fatalf("%s was removed while it may be in use or is not ours", kept)
		}
	}
	entries, _ := os.ReadDir(root)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), runtimeReapPrefix) {
			t.Fatalf("sweep left %s behind", entry.Name())
		}
	}
}

// A reaped directory is re-created on the next use, and a waiter that opened a
// lock before the sweep unlinked it ends up on the live file (see ipc).
func TestRuntimeSweepedDirectoryIsRecreatedOnNextUse(t *testing.T) {
	root := sweepRoot(t)
	dir := commDir(t, root, 1, 2*time.Hour, "sync-a.lock")
	if sweepRuntimeRoot(root, time.Now()) != 1 || exists(dir) {
		t.Fatal("abandoned directory was not reaped")
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(dir, "sync-a.lock"))
	if err != nil {
		t.Fatalf("fence after a sweep: %v", err)
	}
	defer lock.Release()
	if err := checkPrivateDir(dir, false); err != nil {
		t.Fatalf("re-created directory is not private: %v", err)
	}
	if sweepRuntimeRoot(root, time.Now().Add(3*time.Hour)) != 0 || !exists(dir) {
		t.Fatal("a held fence did not protect its directory")
	}
}

// The sweep runs at most once per interval per root and each pass is bounded,
// so the hot path (every socket resolution) pays one stat.
func TestRuntimeSweepIsThrottledAndBounded(t *testing.T) {
	root := sweepRoot(t)
	for i := 0; i < runtimeSweepLimit+5; i++ {
		commDir(t, root, 100+i, 2*time.Hour, "sync-a.lock")
	}
	now := time.Now()
	if removed := sweepRuntimeRootIfDue(root, now); removed != runtimeSweepLimit {
		t.Fatalf("first pass removed %d, want the %d limit", removed, runtimeSweepLimit)
	}
	if removed := sweepRuntimeRootIfDue(root, now.Add(time.Minute)); removed != 0 {
		t.Fatalf("a second pass inside the interval removed %d", removed)
	}
	if removed := sweepRuntimeRootIfDue(root, now.Add(runtimeSweepInterval+time.Minute)); removed != 5 {
		t.Fatalf("the next due pass removed %d, want the remaining 5", removed)
	}
}

// A leftover tombstone (a sweeper killed mid-cleanup) is finished by the next pass.
func TestRuntimeSweepFinishesInterruptedReap(t *testing.T) {
	root := sweepRoot(t)
	tomb := filepath.Join(root, runtimeReapPrefix+"0000000000000001.42.1")
	if err := os.Mkdir(tomb, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tomb, "sync-a.lock"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	sweepRuntimeRoot(root, time.Now())
	if _, err := os.Lstat(tomb); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("tombstone survived: %v", err)
	}
}

// Resolving a socket is what sweeps: no daemon or timer is needed.
func TestSocketResolutionSweepsItsRoot(t *testing.T) {
	root := sweepRoot(t)
	previous := runtimeSweepAutomatic
	runtimeSweepAutomatic = func() bool { return true }
	t.Cleanup(func() { runtimeSweepAutomatic = previous })
	t.Setenv("XDG_RUNTIME_DIR", root)
	abandoned := commDir(t, root, 1, 2*time.Hour, "sync-a.lock")
	socket, err := socketPath(fmt.Sprintf("https://sweep.%d.example", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	if exists(abandoned) {
		t.Fatal("socket resolution left an abandoned directory")
	}
	if !exists(filepath.Dir(socket)) {
		t.Fatal("the resolving server's own directory is missing")
	}
}

// Test binaries never sweep the real per-user runtime root on their own.
func TestRuntimeSweepIsNotAutomaticInTests(t *testing.T) {
	if runtimeSweepAutomatic() {
		t.Fatal("a go test binary would sweep the real runtime root")
	}
}

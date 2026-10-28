package ipc

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A lock whose file was unlinked while the caller waited for it locks nothing:
// the next contender creates a new file at the path and "holds" it too. The
// communicator's runtime sweep (feedback 3e2df8d1) removes idle lock files, so
// an acquisition must end holding the file the path names.
func TestAcquisitionRetriesWhenItsFileWasUnlinkedWhileWaiting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "comm", "sync-x.lock")
	holder, err := TryAcquireExclusivePath(path)
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		lock *Lock
		err  error
	}
	done := make(chan result, 1)
	go func() {
		lock, err := AcquireSharedPath(path) // opens the file, then blocks in flock
		done <- result{lock, err}
	}()
	time.Sleep(150 * time.Millisecond)
	// The sweeper's order: it holds the lock, unlinks, then lets go.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Dir(path)); err != nil {
		t.Fatal(err)
	}
	holder.Release()
	var got result
	select {
	case got = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("waiter never acquired")
	}
	if got.err != nil {
		t.Fatal(got.err)
	}
	defer got.lock.Release()
	held, err := got.lock.f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	named, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("waiter holds an unlinked file and left no lock at the path: %v", err)
	}
	if !os.SameFile(held, named) {
		t.Fatal("waiter holds an unlinked file, not the one the path names")
	}
	// Mutual exclusion holds again: an exclusive contender is refused.
	if other, err := TryAcquireExclusivePath(path); err != ErrHeld {
		if other != nil {
			other.Release()
		}
		t.Fatalf("second holder admitted beside the waiter: %v", err)
	}
}

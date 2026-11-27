//go:build !windows

package layout

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestLayoutLockWidensRestrictiveUmaskForOtherUIDs(t *testing.T) {
	target := filepath.Join(t.TempDir(), "cxx")
	path := lockPathForTarget(target)
	_ = os.Remove(path)
	t.Cleanup(func() { _ = os.Remove(path) })

	old := syscall.Umask(0o077)
	lock, err := AcquireForTarget(context.Background(), target)
	syscall.Umask(old)
	if err != nil {
		t.Fatal(err)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o666 {
		t.Fatalf("lock mode=%#o want 0666", got)
	}
}

func TestLayoutLockRejectsFIFOWithoutBlocking(t *testing.T) {
	target := filepath.Join(t.TempDir(), "cxx")
	path := lockPathForTarget(target)
	_ = os.Remove(path)
	t.Cleanup(func() { _ = os.Remove(path) })
	if err := syscall.Mkfifo(path, 0o666); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireForTarget(context.Background(), target); err == nil {
		t.Fatal("FIFO lock path accepted")
	}
}

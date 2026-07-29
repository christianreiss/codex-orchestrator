package ipc

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestAcquireReleaseRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", dir)
	l, err := Acquire("cdx-test")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "cdx-test.lock")); statErr != nil {
		t.Fatalf("lock file missing: %v", statErr)
	}
	if err := l.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
}

func TestInheritOnExecClearsCloseOnExecFlag(t *testing.T) {
	lease, err := AcquireSharedPath(filepath.Join(t.TempDir(), "inherited.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if err := lease.InheritOnExec(); err != nil {
		t.Fatal(err)
	}
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, lease.f.Fd(), uintptr(syscall.F_GETFD), 0)
	if errno != 0 {
		t.Fatal(errno)
	}
	if flags&uintptr(syscall.FD_CLOEXEC) != 0 {
		t.Fatalf("FD_CLOEXEC remains set: %#x", flags)
	}
}

// TestCountActiveReturnsAtLeastOne covers the floor case — CountActive must
// never report fewer than one peer, since the calling process itself is
// always alive. The exact count depends on what's running on the host, so
// we only assert the minimum invariant.
func TestCountActiveReturnsAtLeastOne(t *testing.T) {
	// Pick a binary name that's effectively guaranteed not to be running
	// (longer than /proc/comm's 15-char cap → no real process matches).
	got := CountActive("definitely-not-a-real-binary-foo")
	if got < 1 {
		t.Fatalf("CountActive must floor at 1, got %d", got)
	}
}

func TestAcquireBlocksWhenHeld(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", dir)
	first, err := Acquire("cdx-test")
	if err != nil {
		t.Fatalf("acquire #1: %v", err)
	}
	defer first.Release()
	path := filepath.Join(dir, "cdx-test.lock")
	owner, readErr := os.ReadFile(path)
	if readErr != nil || len(owner) == 0 {
		t.Fatalf("read owner metadata: %q, %v", owner, readErr)
	}
	_, err = Acquire("cdx-test")
	if !errors.Is(err, ErrHeld) {
		t.Fatalf("expected ErrHeld, got %v", err)
	}
	after, readErr := os.ReadFile(path)
	if readErr != nil || string(after) != string(owner) {
		t.Fatalf("failed contender changed owner metadata: before=%q after=%q err=%v", owner, after, readErr)
	}
}

func TestAcquireDoesNotShareClaudeLock(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", dir)
	clx, err := Acquire("clx-cross-test")
	if err != nil {
		t.Fatalf("acquire clx lock: %v", err)
	}
	defer clx.Release()

	cdx, err := Acquire("cdx-cross-test")
	if err != nil {
		t.Fatalf("cdx lock should not be blocked by clx lock: %v", err)
	}
	defer cdx.Release()
}

func TestSharedSessionLeaseProvesLastProcessInEitherExitOrder(t *testing.T) {
	for _, tc := range []struct {
		name         string
		firstRelease int
	}{
		{name: "owner exits first", firstRelease: 0},
		{name: "secondary exits first", firstRelease: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("XDG_RUNTIME_DIR", dir)
			leases := make([]*Lock, 2)
			for i := range leases {
				var err error
				leases[i], err = AcquireShared("cdx-auth-sessions-test")
				if err != nil {
					t.Fatalf("shared lease %d: %v", i, err)
				}
			}
			if err := leases[tc.firstRelease].Release(); err != nil {
				t.Fatal(err)
			}
			if exclusive, err := TryAcquireExclusive("cdx-auth-sessions-test"); !errors.Is(err, ErrHeld) {
				if exclusive != nil {
					_ = exclusive.Release()
				}
				t.Fatalf("exclusive lease with one active peer: %v", err)
			}
			last := 1 - tc.firstRelease
			if err := leases[last].Release(); err != nil {
				t.Fatal(err)
			}
			exclusive, err := TryAcquireExclusive("cdx-auth-sessions-test")
			if err != nil {
				t.Fatalf("last process could not acquire cleanup lease: %v", err)
			}
			_ = exclusive.Release()
		})
	}
}

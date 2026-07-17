// Package ipc provides a process-wide single-instance lock for the wrapper.
// Concurrent invocations on the same host race the same orchestrator state,
// which is why the v1 wrapper had a bash flock wrapper around the whole thing.
package ipc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// Lock represents an acquired flock; Release closes the underlying fd.
type Lock struct {
	f *os.File
}

// ExecLease is a duplicate lock descriptor intentionally left open across a
// direct syscall.Exec. The original Lock stays CLOEXEC, so a failed exec can
// discard only this duplicate without changing the caller's live lease.
type ExecLease struct {
	f *os.File
}

// InheritOnExec clears FD_CLOEXEC so a syscall.Exec replacement continues to
// hold this lease for the lifetime of the native child. The normal exec.Cmd
// path does not use this; it holds the Go object around Start/Wait instead.
func (l *Lock) InheritOnExec() error {
	if l == nil || l.f == nil {
		return errors.New("lock is not held")
	}
	_, _, errno := syscall.Syscall(syscall.SYS_FCNTL, l.f.Fd(), uintptr(syscall.F_SETFD), 0)
	if errno != 0 {
		return errno
	}
	return nil
}

// DuplicateForExec creates a non-CLOEXEC duplicate of a held lock. The
// duplicate refers to the same open-file description and therefore bridges
// the interval between syscall.Exec closing the original descriptor and the
// restarted process acquiring a replacement lease.
func (l *Lock) DuplicateForExec() (*ExecLease, error) {
	if l == nil || l.f == nil {
		return nil, errors.New("lock is not held")
	}
	fd, _, errno := syscall.Syscall(syscall.SYS_FCNTL, l.f.Fd(), uintptr(syscall.F_DUPFD), 3)
	if errno != 0 {
		return nil, errno
	}
	f := os.NewFile(fd, "inherited-lock")
	if f == nil {
		_ = syscall.Close(int(fd))
		return nil, errors.New("adopt duplicated lock descriptor")
	}
	return &ExecLease{f: f}, nil
}

// FD returns the descriptor number to encode in the exec environment.
func (l *ExecLease) FD() uintptr {
	if l == nil || l.f == nil {
		return 0
	}
	return l.f.Fd()
}

// File exposes the duplicated descriptor for exec.Cmd.ExtraFiles. The caller
// still owns the ExecLease and must Release its parent-side copy after Start;
// the child receives a distinct descriptor referring to the same locked open
// file description.
func (l *ExecLease) File() *os.File {
	if l == nil {
		return nil
	}
	return l.f
}

// Release closes an exec bridge in the original process when syscall.Exec
// fails. On success, the restarted process adopts and closes the same fd.
func (l *ExecLease) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}

// AdoptInheritedPath validates that fd names the expected lock file before
// taking ownership of it. This prevents a manually supplied handoff
// environment from making the wrapper close an unrelated descriptor.
func AdoptInheritedPath(fd uintptr, path string) (*Lock, error) {
	if fd < 3 {
		return nil, fmt.Errorf("invalid inherited lock descriptor %d", fd)
	}
	f := os.NewFile(fd, "inherited-lock")
	if f == nil {
		return nil, fmt.Errorf("adopt inherited lock descriptor %d", fd)
	}
	got, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("stat inherited lock descriptor %d: %w", fd, err)
	}
	want, err := os.Stat(path)
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("stat expected inherited lock %s: %w", path, err)
	}
	if !os.SameFile(got, want) {
		_ = f.Close()
		return nil, fmt.Errorf("inherited lock descriptor %d does not match %s", fd, path)
	}
	return &Lock{f: f}, nil
}

// Acquire takes an exclusive non-blocking flock on a per-user lock file. If
// another instance holds it, returns ErrHeld.
var ErrHeld = errors.New("another wrapper instance is running")

func Acquire(name string) (*Lock, error) {
	return acquire(name, syscall.LOCK_EX|syscall.LOCK_NB, true)
}

// AcquireShared takes a portable shared session lease. Every wrapper process
// that may read/use auth holds this lease while active; insecure-host cleanup
// can then prove it is last by releasing its share and trying an exclusive
// lease. Unlike /proc counting, this works on both Linux and Darwin.
func AcquireShared(name string) (*Lock, error) {
	return acquire(name, syscall.LOCK_SH, false)
}

// TryAcquireExclusive takes a non-blocking exclusive lease without rewriting
// owner metadata. ErrHeld means at least one shared/exclusive peer remains.
func TryAcquireExclusive(name string) (*Lock, error) {
	return acquire(name, syscall.LOCK_EX|syscall.LOCK_NB, false)
}

// AcquireSharedPath takes a blocking shared lease at an explicit path. Auth
// lifecycle locks use this instead of the generic XDG runtime namespace so
// every process targeting the same effective client home coordinates even
// when their XDG_RUNTIME_DIR values differ.
func AcquireSharedPath(path string) (*Lock, error) {
	return acquirePath(path, syscall.LOCK_SH, false, 0o700, 0o600)
}

// TryAcquireSharedPath takes a non-blocking shared lease. It behaves like the
// blocking variant alongside ordinary shared peers, but returns ErrHeld when
// an uninstall/logout maintenance owner has the exclusive side. Auth-aware
// commands use this so a process that loaded config before uninstall cannot
// queue behind it and re-materialize removed state afterwards.
func TryAcquireSharedPath(path string) (*Lock, error) {
	return acquirePath(path, syscall.LOCK_SH|syscall.LOCK_NB, false, 0o700, 0o600)
}

// TryAcquireExclusivePath takes a non-blocking exclusive lease at an explicit
// path. ErrHeld means a shared/exclusive peer still owns that exact resource.
func TryAcquireExclusivePath(path string) (*Lock, error) {
	return acquirePath(path, syscall.LOCK_EX|syscall.LOCK_NB, false, 0o700, 0o600)
}

func acquire(name string, operation int, writeOwner bool) (*Lock, error) {
	path := lockPath(name)
	return acquirePath(path, operation, writeOwner, 0o755, 0o644)
}

func acquirePath(path string, operation int, writeOwner bool, dirMode, fileMode os.FileMode) (*Lock, error) {
	if path == "" {
		return nil, errors.New("lock path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), dirMode); err != nil {
		return nil, err
	}
	// Do not O_TRUNC before acquiring flock: a failed contender would erase
	// the owning process's PID metadata even though it never obtained the lock.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, fileMode)
	if err != nil {
		return nil, fmt.Errorf("open lock %s: %w", path, err)
	}
	if err := syscall.Flock(int(f.Fd()), operation); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrHeld
		}
		return nil, err
	}
	if writeOwner {
		if err := f.Truncate(0); err != nil {
			_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
			_ = f.Close()
			return nil, fmt.Errorf("truncate lock %s: %w", path, err)
		}
		if _, err := f.Seek(0, 0); err != nil {
			_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
			_ = f.Close()
			return nil, fmt.Errorf("seek lock %s: %w", path, err)
		}
		_, _ = fmt.Fprintf(f, "%d\n", os.Getpid())
	}
	return &Lock{f: f}, nil
}

func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	err := l.f.Close()
	l.f = nil
	return err
}

func lockPath(name string) string {
	if runtime := os.Getenv("XDG_RUNTIME_DIR"); runtime != "" {
		return filepath.Join(runtime, name+".lock")
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("%s-%d.lock", name, os.Getuid()))
}

// CountActive walks /proc and reports how many processes on this host share
// the given short name (e.g. "cdx") and the caller's uid. Counts the caller
// itself if it's running, so 1 ≈ "just me", 2+ ≈ at least one concurrent peer.
//
// /proc is Linux-only. On platforms without /proc (or when the walk fails for
// any reason — restricted permissions, container weirdness, etc.) the
// function returns 1 so callers can still render a usable value without
// crashing.
func CountActive(name string) int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 1
	}
	myUID := uint32(os.Getuid())
	want := []byte(name)
	count := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid := e.Name()
		if pid == "" || pid[0] < '0' || pid[0] > '9' {
			continue
		}
		comm, err := os.ReadFile(filepath.Join("/proc", pid, "comm"))
		if err != nil {
			continue
		}
		// /proc/<pid>/comm is the binary basename (truncated to 15 chars) +
		// trailing newline; match exactly to avoid false positives like
		// `cdx-debug` or `cdxhelper`.
		trimmed := comm
		for len(trimmed) > 0 && (trimmed[len(trimmed)-1] == '\n' || trimmed[len(trimmed)-1] == ' ') {
			trimmed = trimmed[:len(trimmed)-1]
		}
		if !bytesEqual(trimmed, want) {
			continue
		}
		st, err := os.Stat(filepath.Join("/proc", pid))
		if err != nil {
			continue
		}
		sys, ok := st.Sys().(*syscall.Stat_t)
		if !ok || sys.Uid != myUID {
			continue
		}
		count++
	}
	if count == 0 {
		// At minimum the caller is alive; if /proc gave us 0 it usually means
		// the caller's own /proc/<pid>/comm wasn't readable yet (race during
		// startup), so treat that as 1 rather than reporting zero sessions.
		return 1
	}
	return count
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

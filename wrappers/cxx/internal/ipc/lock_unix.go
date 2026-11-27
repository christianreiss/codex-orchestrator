//go:build !windows

package ipc

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

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

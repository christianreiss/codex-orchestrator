//go:build !windows

package posix

import (
	"os"
	"syscall"
)

const (
	LOCK_SH = syscall.LOCK_SH
	LOCK_EX = syscall.LOCK_EX
	LOCK_NB = syscall.LOCK_NB
	LOCK_UN = syscall.LOCK_UN

	O_NOFOLLOW = syscall.O_NOFOLLOW
)

// Stat_t is the platform stat record carried by os.FileInfo.Sys().
type Stat_t = syscall.Stat_t

// OpenFile is os.OpenFile.
func OpenFile(name string, flag int, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(name, flag, perm)
}

// Flock is syscall.Flock.
func Flock(fd int, how int) error { return syscall.Flock(fd, how) }

// NewSessionAttr starts a child in its own session, detached from the
// caller's controlling terminal.
func NewSessionAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

// NewProcessGroupAttr starts a child as the leader of a new process group.
func NewProcessGroupAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }

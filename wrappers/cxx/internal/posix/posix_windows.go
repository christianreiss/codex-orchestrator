//go:build windows

package posix

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

// Flock operation bits, BSD numbering. Only Flock below interprets them.
const (
	LOCK_SH = 0x1
	LOCK_EX = 0x2
	LOCK_NB = 0x4
	LOCK_UN = 0x8
)

// O_NOFOLLOW marks an open that must not follow a final symlink. OpenFile
// refuses it explicitly. The value is also a CreateFile flag bit the Go
// runtime rejects, a second layer should a no-follow open reach os.OpenFile.
// windows: no O_NOFOLLOW open semantics, tracked in docs/reports/platform-feasibility-2026-11-27.md
const O_NOFOLLOW = 0x00400000

// errNoFollow is what every no-follow open reports on Windows.
var errNoFollow = errors.New("not supported on windows: O_NOFOLLOW open")

// OpenFile is os.OpenFile, except that a request carrying O_NOFOLLOW fails
// instead of silently following a reparse point.
// windows: no-follow opens refused, tracked in docs/reports/platform-feasibility-2026-11-27.md
func OpenFile(name string, flag int, perm os.FileMode) (*os.File, error) {
	if flag&O_NOFOLLOW != 0 {
		return nil, &os.PathError{Op: "open", Path: name, Err: errNoFollow}
	}
	return os.OpenFile(name, flag, perm)
}

// Stat_t is never what os.FileInfo.Sys() returns on Windows (that is a
// *syscall.Win32FileAttributeData), so every `info.Sys().(*posix.Stat_t)`
// assertion reports !ok and the caller takes its fail-closed branch. The
// fields exist only so shared code compiles.
// windows: no POSIX uid/gid/inode ownership data, tracked in docs/reports/platform-feasibility-2026-11-27.md
type Stat_t struct {
	Dev uint64
	Ino uint64
	Uid uint32
	Gid uint32
}

// The lock covers one byte far beyond any real file content. Windows byte-range
// locks are mandatory, so locking the data itself would block other handles
// from reading the owner PID a lock file carries.
const (
	lockOffsetLow  = 0
	lockOffsetHigh = 0x40000000
)

// Flock emulates flock(2) on a file handle with LockFileEx/UnlockFileEx.
// Like flock, converting between shared and exclusive is not atomic: the held
// lock is dropped before the new one is requested. A contended non-blocking
// request reports syscall.EWOULDBLOCK, which callers already test for.
func Flock(fd int, how int) error {
	handle := windows.Handle(uintptr(fd))
	ol := new(windows.Overlapped)
	ol.Offset = lockOffsetLow
	ol.OffsetHigh = lockOffsetHigh
	unlockErr := windows.UnlockFileEx(handle, 0, 1, 0, ol)
	if unlockErr != nil && !errors.Is(unlockErr, windows.ERROR_NOT_LOCKED) {
		return unlockErr
	}
	if how&LOCK_UN != 0 {
		return nil
	}
	var flags uint32
	switch {
	case how&LOCK_EX != 0:
		flags = windows.LOCKFILE_EXCLUSIVE_LOCK
	case how&LOCK_SH != 0:
	default:
		return syscall.EINVAL
	}
	if how&LOCK_NB != 0 {
		flags |= windows.LOCKFILE_FAIL_IMMEDIATELY
	}
	ol = new(windows.Overlapped)
	ol.Offset = lockOffsetLow
	ol.OffsetHigh = lockOffsetHigh
	err := windows.LockFileEx(handle, flags, 0, 1, 0, ol)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return syscall.EWOULDBLOCK
	}
	return err
}

// stillActive is STILL_ACTIVE, the exit code a running process reports.
const stillActive = 259

// ProcessAlive mirrors the Unix `kill(pid, 0) == nil || EPERM` probe: a
// process that exists but cannot be opened (access denied) still counts as
// alive. Callers use the answer to keep waiting, never to grant access.
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return errors.Is(err, windows.ERROR_ACCESS_DENIED)
	}
	defer windows.CloseHandle(h) //nolint:errcheck
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return true
	}
	return code == stillActive
}

// NewSessionAttr detaches the child from the caller's console and Ctrl+C
// group, the closest Windows analogue of setsid(2).
func NewSessionAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
}

// NewProcessGroupAttr starts the child in a new console process group, so a
// Ctrl+C aimed at the caller does not reach it.
func NewProcessGroupAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

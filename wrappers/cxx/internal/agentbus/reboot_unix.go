//go:build !windows

package agentbus

import (
	"os"
	"syscall"
)

// rebootCredentialAttr runs the resumed process as the original user.
func rebootCredentialAttr(uid, gid uint32, groups []uint32) (*syscall.SysProcAttr, error) {
	return &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid, Groups: groups}}, nil
}

// rebootForegroundAttr makes tty the child's controlling terminal and puts the
// child in the terminal's foreground process group.
func rebootForegroundAttr(tty *os.File) (*syscall.SysProcAttr, error) {
	return &syscall.SysProcAttr{Foreground: true, Ctty: int(tty.Fd())}, nil
}

func terminateForeignWorker(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }

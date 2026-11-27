//go:build !windows

package cron

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// A canceled maintenance child may have started npm, a shell, or systemctl.
// Cancel its own process group so descendants cannot keep an installer alive or
// leave inherited output pipes blocking Wait after the coordinator deadline.
func boundCommandChildren(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = time.Second
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}

func canWriteBinary(path string) bool {
	// Self-update replaces by same-directory rename; access checks avoid opening
	// the currently executing inode O_WRONLY (Linux returns ETXTBSY for that).
	return unix.Access(path, unix.W_OK) == nil && unix.Access(filepath.Dir(path), unix.W_OK) == nil
}

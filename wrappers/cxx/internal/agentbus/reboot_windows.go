//go:build windows

package agentbus

import (
	"errors"
	"os"
	"syscall"
)

// windows: no setuid/setgid credential switch for the resumed process, tracked in docs/reports/platform-feasibility-2026-11-27.md
func rebootCredentialAttr(uid, gid uint32, groups []uint32) (*syscall.SysProcAttr, error) {
	return nil, errors.New("not supported on windows: resuming a reboot as another user")
}

// windows: no controlling-terminal handoff, tracked in docs/reports/platform-feasibility-2026-11-27.md
func rebootForegroundAttr(tty *os.File) (*syscall.SysProcAttr, error) {
	return nil, errors.New("not supported on windows: foreground terminal handoff")
}

// windows: foreign-worker sweep is Linux-only and never enabled here, tracked in docs/reports/platform-feasibility-2026-11-27.md
func terminateForeignWorker(pid int) error {
	return errors.New("not supported on windows: signalling a foreign worker")
}

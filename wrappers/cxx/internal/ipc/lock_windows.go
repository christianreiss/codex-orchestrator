//go:build windows

package ipc

import "errors"

// windows: no syscall.Exec, so no lock descriptor can survive one, tracked in docs/reports/platform-feasibility-2026-11-27.md
func (l *Lock) InheritOnExec() error {
	return errors.New("not supported on windows: lock inheritance across exec")
}

// windows: no fcntl(F_DUPFD) lock bridge, tracked in docs/reports/platform-feasibility-2026-11-27.md
func (l *Lock) DuplicateForExec() (*ExecLease, error) {
	return nil, errors.New("not supported on windows: duplicating a lock for exec")
}

// windows: inherited lock descriptors cannot be validated, tracked in docs/reports/platform-feasibility-2026-11-27.md
func AdoptInheritedPath(fd uintptr, path string) (*Lock, error) {
	return nil, errors.New("not supported on windows: adopting an inherited lock descriptor")
}

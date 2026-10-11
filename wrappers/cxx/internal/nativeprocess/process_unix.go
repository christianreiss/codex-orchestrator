//go:build !windows

package nativeprocess

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func terminationSignals() []os.Signal {
	return []os.Signal{syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP}
}
func terminateSignal() os.Signal { return syscall.SIGTERM }
func prepareGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}
func sendSignal(cmd *exec.Cmd, group bool, signal os.Signal) error {
	if cmd.Process == nil {
		return os.ErrProcessDone
	}
	if !group {
		return cmd.Process.Signal(signal)
	}
	sig, ok := signal.(syscall.Signal)
	if !ok {
		return cmd.Process.Signal(signal)
	}
	err := syscall.Kill(-cmd.Process.Pid, sig)
	if errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	return err
}
func signalExit(signal os.Signal) int {
	if sig, ok := signal.(syscall.Signal); ok {
		return 128 + int(sig)
	}
	return 1
}
func exitCode(err *exec.ExitError) int {
	if status, ok := err.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return 128 + int(status.Signal())
	}
	return err.ExitCode()
}

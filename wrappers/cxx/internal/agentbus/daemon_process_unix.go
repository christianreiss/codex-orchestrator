//go:build !windows

package agentbus

import (
	"os/exec"
	"syscall"
	"time"
)

func prepareDaemonProcess(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func stopDaemonProcess(cmd *exec.Cmd, done <-chan error) {
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGINT)
	select {
	case <-done:
		// The wrapper may exit before its children. Reap the entire owned group.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		return
	case <-time.After(30 * time.Second):
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-done:
		// The wrapper may exit before its children. Reap the entire owned group.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		return
	case <-time.After(10 * time.Second):
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	<-done
}

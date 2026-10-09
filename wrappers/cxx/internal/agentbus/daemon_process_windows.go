//go:build windows

package agentbus

import "os/exec"

func prepareDaemonProcess(cmd *exec.Cmd)                 {}
func stopDaemonProcess(cmd *exec.Cmd, done <-chan error) { _ = cmd.Process.Kill(); <-done }

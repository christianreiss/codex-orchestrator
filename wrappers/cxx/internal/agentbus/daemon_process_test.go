//go:build !windows

package agentbus

import (
	"os/exec"
	"testing"
	"time"
)

func TestDaemonStopReapsOwnedProcessGroup(t *testing.T) {
	cmd := exec.Command("sh", "-c", "trap 'exit 0' INT TERM; while :; do sleep 0.1; done")
	prepareDaemonProcess(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	time.Sleep(100 * time.Millisecond)
	finished := make(chan struct{})
	go func() { stopDaemonProcess(cmd, done); close(finished) }()
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("cooperative stop did not finish")
	}
	if cmd.ProcessState == nil || !cmd.ProcessState.Exited() {
		t.Fatal("process exit must be observed")
	}
}

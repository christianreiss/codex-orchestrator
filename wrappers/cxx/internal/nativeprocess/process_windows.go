//go:build windows

package nativeprocess

import (
	"os"
	"os/exec"
)

func terminationSignals() []os.Signal { return []os.Signal{os.Interrupt} }
func terminateSignal() os.Signal      { return os.Interrupt }
func prepareGroup(cmd *exec.Cmd)      {}
func sendSignal(cmd *exec.Cmd, group bool, signal os.Signal) error {
	if cmd.Process == nil {
		return os.ErrProcessDone
	}
	// Windows does not implement os.Process.Signal(os.Interrupt).
	return cmd.Process.Kill()
}
func signalExit(signal os.Signal) int  { return 130 }
func exitCode(err *exec.ExitError) int { return err.ExitCode() }

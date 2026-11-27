//go:build !windows

package communicator

import (
	"os"
	"syscall"
	"time"
)

func (p *profRig) stopOwner() {
	deadline := time.Now().Add(3 * time.Second)
	for {
		pids := p.ownersOf()
		if len(pids) == 0 {
			break
		}
		signal := syscall.SIGTERM
		if time.Now().After(deadline) {
			signal = syscall.SIGKILL
		}
		for _, pid := range pids {
			_ = syscall.Kill(pid, signal)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// An owner that is shutting down can still be creating its socket directory.
	for i := 0; i < 5; i++ {
		if os.RemoveAll(p.runtime) == nil {
			if _, err := os.Stat(p.runtime); os.IsNotExist(err) {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
}

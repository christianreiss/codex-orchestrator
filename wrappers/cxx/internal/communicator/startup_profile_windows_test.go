//go:build windows

package communicator

import (
	"os"
	"time"
)

// stopOwner kills any owner the rig started; Windows has no SIGTERM grace.
func (p *profRig) stopOwner() {
	for _, pid := range p.ownersOf() {
		if proc, err := os.FindProcess(pid); err == nil {
			_ = proc.Kill()
		}
	}
	for i := 0; i < 5; i++ {
		if os.RemoveAll(p.runtime) == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

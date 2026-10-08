//go:build !linux

package schedulewatch

import "os"

type processActivity struct {
	known bool
	cpu   uint64
	tool  bool
}

// No verified native process activity source: do not infer a hang.
func activity(int) processActivity  { return processActivity{} }
func terminate(p *os.Process) error { return p.Signal(os.Interrupt) }

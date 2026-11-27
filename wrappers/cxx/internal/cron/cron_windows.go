//go:build windows

package cron

import (
	"os"
	"os/exec"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/posix"
)

// boundCommandChildren isolates the child in its own console group and kills
// it on cancel. Unlike the Unix process-group kill, descendants it started
// survive; bounding them needs a Job object.
// windows: cancel kills the direct child only, not its descendants, tracked in docs/reports/platform-feasibility-2026-11-27.md
func boundCommandChildren(cmd *exec.Cmd) {
	cmd.SysProcAttr = posix.NewProcessGroupAttr()
	cmd.WaitDelay = time.Second
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		return cmd.Process.Kill()
	}
}

// canWriteBinary reports false, so self-update never replaces the binary in
// place on the strength of a check this platform cannot make.
// windows: no access(2) W_OK probe for the running binary, tracked in docs/reports/platform-feasibility-2026-11-27.md
func canWriteBinary(path string) bool { return false }

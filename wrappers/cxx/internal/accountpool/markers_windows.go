//go:build windows

package accountpool

import "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/posix"

func processAlive(pid int) bool { return posix.ProcessAlive(pid) }

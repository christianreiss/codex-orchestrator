package main

import (
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/update"
)

// snapshottedArgvForTest exposes update.SnapshottedArgv via the test build
// without leaking it from the production binary.
func snapshottedArgvForTest() []string {
	return update.SnapshottedArgv
}

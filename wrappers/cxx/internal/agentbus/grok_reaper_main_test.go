package agentbus

import (
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == native.PrivateReaperCommand {
		os.Exit(native.RunPrivateReaper(os.Args[2:]))
	}
	// Tests may run as root in a container: never signal real processes or
	// touch real homes from service install tests (foreign_workers_test.go
	// enables the sweep against a fake root).
	foreignSweepEnabled = func() bool { return false }
	os.Exit(m.Run())
}

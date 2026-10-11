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
	os.Exit(m.Run())
}

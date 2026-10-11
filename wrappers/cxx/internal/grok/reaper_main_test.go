package grok

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == PrivateReaperCommand {
		os.Exit(RunPrivateReaper(os.Args[2:]))
	}
	os.Exit(m.Run())
}

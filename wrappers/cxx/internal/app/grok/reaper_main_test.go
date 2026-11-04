package grok

import (
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	if marker := os.Getenv("CXX_TEST_GROK_VERSION_PROBES"); marker != "" && len(os.Args) == 2 && os.Args[1] == "--version" {
		f, err := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			os.Exit(2)
		}
		_, _ = f.WriteString("probe\n")
		_ = f.Close()
		if os.Getenv("CXX_TEST_GROK_VERSION_FAIL") == "1" {
			os.Exit(1)
		}
		_, _ = os.Stdout.WriteString("grok " + os.Getenv("CXX_TEST_GROK_VERSION") + "\n")
		os.Exit(0)
	}
	if len(os.Args) > 1 && os.Args[1] == native.PrivateReaperCommand {
		os.Exit(native.RunPrivateReaper(os.Args[2:]))
	}
	os.Exit(m.Run())
}

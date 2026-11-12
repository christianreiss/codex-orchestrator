package kimi

import (
	"os"
	"testing"

	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/kimi"
)

func TestMain(m *testing.M) {
	if marker := os.Getenv("CXX_TEST_KIMI_VERSION_PROBES"); marker != "" && len(os.Args) == 2 && os.Args[1] == "--version" {
		f, err := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			os.Exit(2)
		}
		_, _ = f.WriteString("probe\n")
		_ = f.Close()
		if os.Getenv("CXX_TEST_KIMI_VERSION_FAIL") == "1" {
			os.Exit(1)
		}
		_, _ = os.Stdout.WriteString("kimi " + os.Getenv("CXX_TEST_KIMI_VERSION") + "\n")
		os.Exit(0)
	}
	if len(os.Args) > 1 && os.Args[1] == native.PrivateReaperCommand {
		os.Exit(native.RunPrivateReaper(os.Args[2:]))
	}
	os.Exit(m.Run())
}

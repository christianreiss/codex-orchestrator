package claude

import (
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
)

func TestCheckCLIUsesRunningWrapperVersion(t *testing.T) {
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")

	row := checkCLI(&config.Config{Wrapper: config.Wrapper{Version: "0.6.5"}}, "0.6.15")

	if !strings.Contains(row.Value, "wrapper=0.6.15") {
		t.Fatalf("expected running wrapper version, got %q", row.Value)
	}
	if strings.Contains(row.Value, "wrapper=0.6.5") {
		t.Fatalf("doctor leaked stale config wrapper version: %q", row.Value)
	}
}

func TestCheckCLIFallsBackToConfigWrapperVersion(t *testing.T) {
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")

	row := checkCLI(&config.Config{Wrapper: config.Wrapper{Version: "0.6.5"}}, "")

	if !strings.Contains(row.Value, "wrapper=0.6.5") {
		t.Fatalf("expected config fallback wrapper version, got %q", row.Value)
	}
}

package claude

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
)

func TestCheckCLIUsesRunningWrapperVersion(t *testing.T) {
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")

	row := checkCLI(context.Background(), &config.Config{Wrapper: config.Wrapper{Version: "0.6.5"}}, "0.6.15")

	if row.Tone != ui.ToneFail {
		t.Fatalf("missing upstream CLI should fail, got tone %q", row.Tone)
	}
	if !strings.Contains(row.Value, "wrapper=0.6.15") {
		t.Fatalf("expected running wrapper version, got %q", row.Value)
	}
	if strings.Contains(row.Value, "wrapper=0.6.5") {
		t.Fatalf("doctor leaked stale config wrapper version: %q", row.Value)
	}
}

func TestCheckPathsFailsWhenUpstreamCLIIsMissing(t *testing.T) {
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")

	row := checkPaths()

	if row.Tone != ui.ToneFail || !strings.Contains(row.Value, "claude unavailable") {
		t.Fatalf("missing upstream CLI was not reported truthfully: %#v", row)
	}
}

func TestCheckCLIWarnsWhenVersionProbeFails(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(bin, []byte("not executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)

	row := checkCLI(context.Background(), nil, "0.6.15")

	if row.Tone != ui.ToneWarn || !strings.Contains(row.Value, "version probe failed") {
		t.Fatalf("failed version probe was not reported as a warning: %#v", row)
	}
}

func TestDependencySummaryDoesNotDuplicateStatusIcons(t *testing.T) {
	got := dependencySummary([]string{"curl"}, []string{"node"})
	if strings.ContainsAny(got, "✅⚠⛔") {
		t.Fatalf("dependency value contains a second status icon: %q", got)
	}
	if got != "available: curl; missing: node" {
		t.Fatalf("dependencySummary = %q", got)
	}
}

func TestCheckCLIFallsBackToConfigWrapperVersion(t *testing.T) {
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")

	row := checkCLI(context.Background(), &config.Config{Wrapper: config.Wrapper{Version: "0.6.5"}}, "")

	if !strings.Contains(row.Value, "wrapper=0.6.5") {
		t.Fatalf("expected config fallback wrapper version, got %q", row.Value)
	}
}

func TestTallyRows(t *testing.T) {
	rows := []ui.DoctorRow{
		{Tone: ui.ToneOK},
		{Tone: ui.ToneWarn},
		{Tone: ui.ToneFail},
	}

	failures, worst := tallyRows(rows)
	if failures != 1 || worst != ui.ToneFail {
		t.Fatalf("tallyRows = (%d, %q), want (1, %q)", failures, worst, ui.ToneFail)
	}
}

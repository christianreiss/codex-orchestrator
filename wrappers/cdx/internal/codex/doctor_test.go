package codex

import (
	"context"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ui"
)

func TestCheckCLIUsesRunningWrapperVersion(t *testing.T) {
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")

	row := checkCLI(context.Background(), &config.Config{Wrapper: config.Wrapper{Version: "0.6.5"}}, "0.6.15")

	if !strings.Contains(row.Value, "wrapper=0.6.15") {
		t.Fatalf("expected running wrapper version, got %q", row.Value)
	}
	if strings.Contains(row.Value, "wrapper=0.6.5") {
		t.Fatalf("doctor leaked stale config wrapper version: %q", row.Value)
	}
}

func TestCheckCLIFallsBackToConfigWrapperVersion(t *testing.T) {
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")

	row := checkCLI(context.Background(), &config.Config{Wrapper: config.Wrapper{Version: "0.6.5"}}, "")

	if !strings.Contains(row.Value, "wrapper=0.6.5") {
		t.Fatalf("expected config fallback wrapper version, got %q", row.Value)
	}
}

// TestTallyRows pins the doctor verdict to EVERY row's tone — the regression
// that let a red Disk/Sync row (or a ⚠ Cron row) coexist with an
// "all checks passed" / exit-0 result.
func TestTallyRows(t *testing.T) {
	mk := func(tones ...ui.Tone) []ui.DoctorRow {
		rows := make([]ui.DoctorRow, len(tones))
		for i, tone := range tones {
			rows[i] = ui.DoctorRow{Tone: tone}
		}
		return rows
	}
	cases := []struct {
		name      string
		rows      []ui.DoctorRow
		wantFail  int
		wantWorst ui.Tone
	}{
		{"all ok", mk(ui.ToneOK, ui.ToneOK), 0, ui.ToneOK},
		{"trailing disk fail counts", mk(ui.ToneOK, ui.ToneOK, ui.ToneFail), 1, ui.ToneFail},
		{"cron warn downgrades verdict", mk(ui.ToneOK, ui.ToneWarn), 0, ui.ToneWarn},
		{"fail dominates warn", mk(ui.ToneWarn, ui.ToneFail, ui.ToneWarn), 1, ui.ToneFail},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotFail, gotWorst := tallyRows(tc.rows)
			if gotFail != tc.wantFail || gotWorst != tc.wantWorst {
				t.Fatalf("tallyRows = (%d,%v), want (%d,%v)", gotFail, gotWorst, tc.wantFail, tc.wantWorst)
			}
		})
	}
}

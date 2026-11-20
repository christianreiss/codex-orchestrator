package launcherdoctor

import (
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func TestDependencySummaryDoesNotDuplicateStatusIcons(t *testing.T) {
	got := DependencySummary([]string{"curl"}, []string{"node"})
	if strings.ContainsAny(got, "✅⚠⛔") {
		t.Fatalf("dependency value contains a second status icon: %q", got)
	}
	if got != "available: curl; missing: node" {
		t.Fatalf("DependencySummary = %q", got)
	}
}

func TestCapsHonorsExplicitMinimal(t *testing.T) {
	rich := terminalui.Caps{
		IsTTY:   true,
		UTF8:    true,
		Columns: 120,
		Palette: terminalui.Palette{Bold: "\x1b[1m", Reset: "\x1b[0m", Green: "\x1b[32m"},
	}
	got := Caps(rich, true)
	if got.IsTTY || !got.NoColor || !got.Dumb || got.UTF8 || got.Palette != (terminalui.Palette{}) {
		t.Fatalf("minimal doctor retained rich capabilities: %+v", got)
	}
	if unchanged := Caps(rich, false); unchanged != rich {
		t.Fatalf("normal doctor capabilities changed: got=%+v want=%+v", unchanged, rich)
	}
}

// TestTally pins the doctor verdict to EVERY row's tone — the regression
// that let a red Disk/Sync row (or a ⚠ Cron row) coexist with an
// "all checks passed" / exit-0 result.
func TestTally(t *testing.T) {
	mk := func(tones ...terminalui.Tone) []terminalui.DoctorRow {
		rows := make([]terminalui.DoctorRow, len(tones))
		for i, tone := range tones {
			rows[i] = terminalui.DoctorRow{Tone: tone}
		}
		return rows
	}
	cases := []struct {
		name      string
		rows      []terminalui.DoctorRow
		wantFail  int
		wantWorst terminalui.Tone
	}{
		{"all ok", mk(terminalui.ToneOK, terminalui.ToneOK), 0, terminalui.ToneOK},
		{"trailing disk fail counts", mk(terminalui.ToneOK, terminalui.ToneOK, terminalui.ToneFail), 1, terminalui.ToneFail},
		{"cron warn downgrades verdict", mk(terminalui.ToneOK, terminalui.ToneWarn), 0, terminalui.ToneWarn},
		{"fail dominates warn", mk(terminalui.ToneWarn, terminalui.ToneFail, terminalui.ToneWarn), 1, terminalui.ToneFail},
		{"ok warn fail", mk(terminalui.ToneOK, terminalui.ToneWarn, terminalui.ToneFail), 1, terminalui.ToneFail},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotFail, gotWorst := Tally(tc.rows)
			if gotFail != tc.wantFail || gotWorst != tc.wantWorst {
				t.Fatalf("Tally = (%d,%v), want (%d,%v)", gotFail, gotWorst, tc.wantFail, tc.wantWorst)
			}
		})
	}
}

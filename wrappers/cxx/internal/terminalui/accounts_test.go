package terminalui

import (
	"bytes"
	"fmt"
	"os"
	"strings"
	"testing"
)

func pct(v int) *int { return &v }

// productionPool is the operator's pool: #1 bound and high, #8 enrolled
// without a reading and the target of a pending switch.
func productionPool() []QuotaAccount {
	return []QuotaAccount{
		{ID: 1, Label: "email@christian-reiss.example", Short: pct(12), Weekly: pct(87), Bound: true, Note: "in use", WarnAtPct: 85, BlockAtPct: 95},
		{ID: 8, Label: "christian.reiss@dalason.example", Target: true, Note: "switching here", WarnAtPct: 85, BlockAtPct: 95},
	}
}

func TestAccountRowsAlignOnTheRichCard(t *testing.T) {
	for _, width := range []int{60, 80} {
		t.Run(fmt.Sprintf("width_%d", width), func(t *testing.T) {
			caps := screenCaps(width)
			var buf bytes.Buffer
			printBootScreen(&buf, ScreenInput{
				EngineName: "claude", EngineVersion: "2.1.206", WrapperVersion: "0.9.208",
				QuotaRows:     []QuotaRow{{Label: "weekly", Used: 87, WarnAtPct: 85, BlockAtPct: 95}},
				QuotaAccounts: productionPool(),
				QuotaNote:     "Account pool: 2 accounts; policy auto/balanced; bound #1. Another account has headroom; keep working.",
				ResultLabel:   "Ready.", ResultTone: ToneOK,
			}, caps)
			plain := StripANSI(buf.String())
			if os.Getenv("CXX_PREVIEW") != "" {
				t.Logf("\n%s", plain)
			}
			assertScreenLinesFit(t, buf.String(), width)
			var rows []string
			for _, line := range strings.Split(plain, "\n") {
				if strings.Contains(line, "#1 ") || strings.Contains(line, "#8 ") {
					rows = append(rows, line)
				}
			}
			if len(rows) != 2 {
				t.Fatalf("account rows = %q\n%s", rows, plain)
			}
			first, second := strings.Index(rows[0], "5h 12%"), strings.Index(rows[1], "no reading")
			if first < 0 || first != second {
				t.Fatalf("usage column misaligned (%d vs %d):\n%s\n%s", first, second, rows[0], rows[1])
			}
			for _, want := range []string{"●", "→", "in use", "switching here", "Account pool: 2 accounts"} {
				if !strings.Contains(plain, want) {
					t.Fatalf("missing %q:\n%s", want, plain)
				}
			}
		})
	}
}

func TestAccountRowsWrapEveryNoteWhenTooNarrow(t *testing.T) {
	lines := formatAccountLines(Caps{UTF8: true}, productionPool(), 40)
	if len(lines) != 4 {
		t.Fatalf("lines = %q", lines)
	}
	if strings.Index(lines[0], "5h") != strings.Index(lines[2], "no reading") {
		t.Fatalf("narrow rows misaligned:\n%s", strings.Join(lines, "\n"))
	}
	for _, line := range lines {
		if VisibleWidth(line) > 40 {
			t.Fatalf("line exceeds width: %q", line)
		}
	}
	ascii := formatAccountLines(Caps{Dumb: true}, productionPool(), 80)
	if !strings.HasPrefix(ascii[0], "* #1") || !strings.HasPrefix(ascii[1], "> #8") {
		t.Fatalf("ascii markers: %q", ascii)
	}
}

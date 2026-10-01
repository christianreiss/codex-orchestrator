package terminalui

import (
	"bytes"
	"strings"
	"testing"
)

func TestQuotaNoteIsNeutralInRichAndMinimalScreens(t *testing.T) {
	for _, rich := range []bool{true, false} {
		t.Run(map[bool]string{true: "rich", false: "minimal"}[rich], func(t *testing.T) {
			in := ScreenInput{Prefix: "cgx", EngineName: "grok", Model: "grok-4.6", Effort: "high", QuotaNote: "Subscription quota usage is unavailable.", ResultTone: ToneOK, ResultLabel: "Ready."}
			var buf bytes.Buffer
			caps := screenCaps(80)
			caps.IsTTY = rich
			printBootScreen(&buf, in, caps)
			out := StripANSI(buf.String())
			if !strings.Contains(out, in.QuotaNote) || !strings.Contains(out, "grok-4.6/high") {
				t.Fatalf("missing neutral quota context: %s", out)
			}
			for _, incorrect := range []string{"0%", "ATTENTION", "warning |", "blocked |"} {
				if strings.Contains(out, incorrect) {
					t.Fatalf("unavailable quota became %q: %s", incorrect, out)
				}
			}
			if rich {
				assertScreenLinesFit(t, out, caps.Columns)
			}
		})
	}
}

func TestAbsentQuotaNotePreservesExistingEngineOutput(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		var buf bytes.Buffer
		PrintMinimalScreen(&buf, ScreenInput{EngineName: engine, ResultLabel: "Ready."})
		if strings.Contains(buf.String(), "quota |") {
			t.Fatalf("introduced quota section for %s: %s", engine, buf.String())
		}
	}
}

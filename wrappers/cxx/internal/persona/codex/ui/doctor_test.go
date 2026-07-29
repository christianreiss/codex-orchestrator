package ui

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestPrintDoctorRichCardIsResponsiveAndSanitized(t *testing.T) {
	caps := doctorRendererCaps(48)
	report := doctorRendererReport("cdx")

	var buf bytes.Buffer
	PrintDoctor(&buf, caps, report)
	out := buf.String()
	plain := StripANSI(out)

	for _, want := range []string{"CDX", "DOCTOR", "CHECKS", "GUIDANCE", "VERDICT", "✓", "!", "×"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("doctor card missing %q:\n%s", want, plain)
		}
	}
	if strings.Contains(out, "\x1b[99m") || !strings.Contains(plain, "reachable owned value") {
		t.Fatalf("dynamic terminal controls were not sanitized:\n%q", out)
	}
	assertDoctorLinesFit(t, out, caps.Columns)
}

func TestPrintDoctorPlainModesUseExplicitStatusWords(t *testing.T) {
	for _, tc := range []struct {
		name string
		caps Caps
	}{
		{name: "redirected", caps: doctorRendererCaps(38)},
		{name: "dumb", caps: doctorRendererCaps(38)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			caps := tc.caps
			if tc.name == "redirected" {
				caps.IsTTY = false
			} else {
				caps.Dumb = true
			}

			var buf bytes.Buffer
			PrintDoctor(&buf, caps, doctorRendererReport("cdx"))
			out := buf.String()
			for _, want := range []string{"CDX DOCTOR", "OK", "WARN", "FAIL", "GUIDANCE", "VERDICT"} {
				if !strings.Contains(out, want) {
					t.Fatalf("plain doctor report missing %q:\n%s", want, out)
				}
			}
			if strings.Contains(out, "\x1b[") || strings.ContainsAny(out, "✓×") {
				t.Fatalf("plain doctor report contains terminal decoration:\n%q", out)
			}
			assertDoctorLinesFit(t, out, caps.Columns)
		})
	}
}

func TestPrintDoctorTinyTTYNeverExceedsDetectedWidth(t *testing.T) {
	caps := doctorRendererCaps(7)
	var buf bytes.Buffer

	PrintDoctor(&buf, caps, doctorRendererReport("cdx"))

	assertDoctorLinesFit(t, buf.String(), caps.Columns)
}

func doctorRendererReport(engine string) DoctorReport {
	return DoctorReport{
		Engine: engine,
		When:   time.Date(2026, time.July, 15, 9, 7, 0, 0, time.UTC),
		Rows: []DoctorRow{
			{Label: "Deps", Tone: ToneOK, Value: "available: curl"},
			{Label: "Config", Tone: ToneWarn, Value: "settings will sync on the next online run"},
			{Label: "API", Tone: ToneFail, Value: "reachable\x1b[99m\nowned\tvalue"},
		},
		Hints:  []string{"Reconnect, then run the doctor again to verify the repaired state."},
		Result: DoctorRow{Label: "Result", Tone: ToneFail, Value: "1 check failed"},
	}
}

func doctorRendererCaps(columns int) Caps {
	return Caps{
		IsTTY:   true,
		UTF8:    true,
		Columns: columns,
		Theme:   ThemeOrange,
		Palette: Palette{
			Bold:   "\x1b[1m",
			Dim:    "\x1b[2m",
			Reset:  "\x1b[0m",
			Green:  "\x1b[32m",
			Yellow: "\x1b[33m",
			Orange: "\x1b[38;5;208m",
			Red:    "\x1b[31m",
		},
		BannerSym: BannerGlyphs{
			BoxTL: "╭", BoxTR: "╮", BoxBL: "╰", BoxBR: "╯", BoxH: "─", BoxV: "│",
		},
	}
}

func assertDoctorLinesFit(t *testing.T, output string, columns int) {
	t.Helper()
	for i, line := range strings.Split(strings.TrimSuffix(output, "\n"), "\n") {
		if got := VisibleWidth(line); got > columns {
			t.Fatalf("line %d is %d columns wide, cap is %d: %q", i+1, got, columns, line)
		}
	}
}

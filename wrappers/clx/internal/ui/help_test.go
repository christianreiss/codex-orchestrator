package ui

import (
	"bytes"
	"strings"
	"testing"
)

func TestPrintWrapperHelpPlainIsANSIFreeAndComplete(t *testing.T) {
	t.Parallel()

	caps := wrapperHelpTestCaps(64, false, false)
	var out bytes.Buffer
	PrintWrapperHelp(&out, caps)
	got := out.String()

	if strings.Contains(got, "\x1b") {
		t.Fatalf("plain help contains ANSI escapes:\n%q", got)
	}
	for _, want := range []string{
		"CLX WRAPPER HELP",
		"clx auth-upload",
		"--continue",
		"--dangerously-skip-permissions",
		"--minimal",
		"--silent",
		"--help opens Claude help;",
		"--wrapper-help opens this wrapper",
		"surface.",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("plain help missing %q:\n%s", want, got)
		}
	}
	assertWrapperHelpWidth(t, got, caps.Columns)
}

func TestPrintWrapperHelpDumbIsPlainAndWidthBound(t *testing.T) {
	t.Parallel()

	caps := wrapperHelpTestCaps(36, true, true)
	var out bytes.Buffer
	PrintWrapperHelp(&out, caps)
	got := out.String()

	if strings.Contains(got, "\x1b") {
		t.Fatalf("dumb-terminal help contains ANSI escapes:\n%q", got)
	}
	if !strings.Contains(got, "--wrapper-help") {
		t.Fatalf("dumb-terminal help does not expose wrapper help:\n%s", got)
	}
	assertWrapperHelpWidth(t, got, caps.Columns)
}

func TestPrintWrapperHelpRichUsesVioletAndStaysWithinWidth(t *testing.T) {
	t.Parallel()

	caps := wrapperHelpTestCaps(64, true, false)
	var out bytes.Buffer
	PrintWrapperHelp(&out, caps)
	got := out.String()

	if !strings.Contains(got, caps.Palette.Violet) {
		t.Fatalf("rich help does not use the clx violet accent:\n%q", got)
	}
	plain := StripANSI(got)
	for _, want := range []string{"CLX", "WRAPPER HELP", "--continue", "--wrapper-help"} {
		if !strings.Contains(plain, want) {
			t.Errorf("rich help missing %q:\n%s", want, plain)
		}
	}
	assertWrapperHelpWidth(t, got, caps.Columns)
}

func wrapperHelpTestCaps(columns int, isTTY, dumb bool) Caps {
	return Caps{
		IsTTY:   isTTY,
		Dumb:    dumb,
		UTF8:    !dumb,
		Columns: columns,
		Palette: Palette{
			Bold:   "\x1b[1m",
			Dim:    "\x1b[2m",
			Reset:  "\x1b[0m",
			Orange: "\x1b[38;5;208m",
			Violet: "\x1b[38;5;141m",
		},
		BannerSym: BannerGlyphs{
			BoxTL: "╭",
			BoxTR: "╮",
			BoxBL: "╰",
			BoxBR: "╯",
			BoxH:  "─",
			BoxV:  "│",
		},
	}
}

func assertWrapperHelpWidth(t *testing.T, output string, width int) {
	t.Helper()
	for lineNumber, line := range strings.Split(strings.TrimSuffix(output, "\n"), "\n") {
		if got := VisibleWidth(line); got > width {
			t.Errorf("line %d is %d columns, want <= %d: %q", lineNumber+1, got, width, StripANSI(line))
		}
	}
}

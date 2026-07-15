package ui

import (
	"fmt"
	"io"
	"strings"
	"time"
)

// DoctorRow is one diagnostic in a doctor report.
type DoctorRow struct {
	Label string
	Tone  Tone
	Value string
}

// DoctorReport is the structured input to PrintDoctor.
type DoctorReport struct {
	Engine string
	When   time.Time
	Rows   []DoctorRow
	Hints  []string
	Result DoctorRow
}

// PrintDoctor renders a responsive card on capable terminals and a compact,
// ANSI-free report for pipes and dumb terminals.
func PrintDoctor(w io.Writer, caps Caps, report DoctorReport) {
	if !caps.IsTTY || caps.Dumb || caps.Columns < minRichColumns {
		printDoctorASCII(w, caps, report)
		return
	}
	printDoctorCard(w, caps, report)
}

func printDoctorCard(w io.Writer, caps Caps, report DoctorReport) {
	c := newCard(w, caps)
	engine := strings.ToUpper(CleanInline(report.Engine))
	if engine == "" {
		engine = "CLI"
	}
	brand := caps.BannerColor() + engine + caps.Palette.Reset
	title := caps.Palette.Bold + "DOCTOR" + caps.Palette.Reset
	header := brand + "  " + title
	when := formatDoctorTime(report.When)
	if when != "" {
		when = caps.Palette.Dim + when + caps.Palette.Reset
	}

	c.top()
	c.line(joinSides(header, when, c.inner, caps))
	c.divider("Checks")

	labelWidth := doctorLabelWidth(report)
	for _, row := range report.Rows {
		printDoctorCardRow(c, caps, labelWidth, row)
	}

	c.divider("Guidance")
	printDoctorCardGuidance(c, caps, report)

	c.divider("Verdict")
	if report.Result.Label != "" || report.Result.Value != "" {
		printDoctorCardRow(c, caps, labelWidth, report.Result)
	}
	c.bottom()
}

func printDoctorCardRow(c card, caps Caps, labelWidth int, row DoctorRow) {
	label := strings.ToUpper(CleanInline(row.Label))
	if label == "" {
		label = "CHECK"
	}
	label = TruncateText(label, labelWidth, caps)
	label = PadRight(label, labelWidth)

	symbol := styleTone(caps, row.Tone, toneSymbol(caps, row.Tone, false))
	styledLabel := caps.Palette.Bold + label + caps.Palette.Reset
	prefix := symbol + " " + styledLabel + "  "
	valueWidth := c.inner - VisibleWidth(prefix)
	if valueWidth < 8 {
		head := symbol + " " + caps.Palette.Bold + strings.TrimSpace(label) + caps.Palette.Reset
		c.line(head)
		for _, line := range WrapText(row.Value, c.inner) {
			c.line(line)
		}
		return
	}

	lines := WrapText(row.Value, valueWidth)
	for i, line := range lines {
		if i == 0 {
			c.line(prefix + line)
			continue
		}
		c.line(strings.Repeat(" ", VisibleWidth(prefix)) + line)
	}
}

func printDoctorCardGuidance(c card, caps Caps, report DoctorReport) {
	if len(report.Hints) == 0 {
		message := "No action required."
		tone := ToneOK
		if report.Result.Tone == ToneWarn || report.Result.Tone == ToneFail {
			message = "Review the warning and failure rows above."
			tone = report.Result.Tone
		}
		printDoctorCardHint(c, caps, toneSymbol(caps, tone, false), tone, message)
		return
	}
	for i, hint := range report.Hints {
		printDoctorCardHint(c, caps, fmt.Sprintf("%d", i+1), ToneWarn, hint)
	}
}

func printDoctorCardHint(c card, caps Caps, marker string, tone Tone, value string) {
	marker = styleTone(caps, tone, CleanInline(marker))
	prefix := marker + "  "
	valueWidth := c.inner - VisibleWidth(prefix)
	if valueWidth < 8 {
		c.line(marker)
		for _, line := range WrapText(value, c.inner) {
			c.line(line)
		}
		return
	}
	for i, line := range WrapText(value, valueWidth) {
		if i == 0 {
			c.line(prefix + line)
			continue
		}
		c.line(strings.Repeat(" ", VisibleWidth(prefix)) + line)
	}
}

func printDoctorASCII(w io.Writer, caps Caps, report DoctorReport) {
	width := caps.Columns
	if width <= 0 {
		width = 80
	}
	asciiCaps := caps
	asciiCaps.Dumb = true
	asciiCaps.UTF8 = false
	asciiCaps.Palette = Palette{}
	engine := strings.ToUpper(CleanInline(report.Engine))
	if engine == "" {
		engine = "CLI"
	}
	header := engine + " DOCTOR"
	if when := formatDoctorTime(report.When); when != "" {
		header += " | " + when
	}
	printDoctorASCIIText(w, width, header)
	printDoctorASCIIText(w, width, "CHECKS")

	labelWidth := doctorLabelWidth(report)
	for _, row := range report.Rows {
		printDoctorASCIIRow(w, asciiCaps, width, labelWidth, row)
	}

	printDoctorASCIIText(w, width, "GUIDANCE")
	if len(report.Hints) == 0 {
		tone := ToneOK
		message := "No action required."
		if report.Result.Tone == ToneWarn || report.Result.Tone == ToneFail {
			tone = report.Result.Tone
			message = "Review the warning and failure rows above."
		}
		printDoctorASCIIRow(w, asciiCaps, width, labelWidth, DoctorRow{Label: "Guide", Tone: tone, Value: message})
	} else {
		for i, hint := range report.Hints {
			printDoctorASCIIRow(w, asciiCaps, width, labelWidth, DoctorRow{Label: fmt.Sprintf("Hint %d", i+1), Tone: ToneWarn, Value: hint})
		}
	}

	printDoctorASCIIText(w, width, "VERDICT")
	if report.Result.Label != "" || report.Result.Value != "" {
		printDoctorASCIIRow(w, asciiCaps, width, labelWidth, report.Result)
	}
}

func printDoctorASCIIRow(w io.Writer, caps Caps, width, labelWidth int, row DoctorRow) {
	status := doctorStatusWord(row.Tone)
	label := strings.ToUpper(PlainInline(row.Label))
	if label == "" {
		label = "CHECK"
	}
	label = PadRight(TruncateText(label, labelWidth, caps), labelWidth)
	prefix := PadRight(status, 4) + " " + label + " | "
	valueWidth := width - VisibleWidth(prefix)
	if valueWidth < 8 {
		printDoctorASCIIText(w, width, status+" "+strings.TrimSpace(label)+" "+CleanInline(row.Value))
		return
	}
	for i, line := range WrapText(PlainInline(row.Value), valueWidth) {
		if i == 0 {
			fmt.Fprintln(w, prefix+line)
			continue
		}
		fmt.Fprintln(w, strings.Repeat(" ", VisibleWidth(prefix))+line)
	}
}

func printDoctorASCIIText(w io.Writer, width int, value string) {
	for _, line := range WrapText(PlainInline(value), width) {
		fmt.Fprintln(w, line)
	}
}

func doctorLabelWidth(report DoctorReport) int {
	width := 6
	rows := append([]DoctorRow(nil), report.Rows...)
	rows = append(rows, report.Result)
	for _, row := range rows {
		if candidate := VisibleWidth(CleanInline(row.Label)); candidate > width {
			width = candidate
		}
	}
	if width > 12 {
		width = 12
	}
	return width
}

func doctorStatusWord(tone Tone) string {
	switch tone {
	case ToneWarn:
		return "WARN"
	case ToneFail:
		return "FAIL"
	case ToneDim:
		return "INFO"
	default:
		return "OK"
	}
}

func formatDoctorTime(when time.Time) string {
	if when.IsZero() {
		return ""
	}
	return when.Format("2006-01-02 15:04")
}

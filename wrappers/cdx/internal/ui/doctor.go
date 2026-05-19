package ui

import (
	"fmt"
	"io"
	"strings"
)

// DoctorRow is one line in the doctor table.
type DoctorRow struct {
	Label string
	Tone  Tone
	Value string
}

// DoctorReport is the structured input to PrintDoctor.
type DoctorReport struct {
	WhenLine string // e.g. "cdx 2026-05-19 14:23  ·  Doctor report"
	Rows     []DoctorRow
	Hints    []string // shown below the table in yellow
	Result   DoctorRow
}

// PrintDoctor renders the legacy doctor visual: dim divider, header line,
// then a left-aligned table with the label column padded to the widest label,
// followed by hint lines and a closing divider.
func PrintDoctor(w io.Writer, caps Caps, r DoctorReport) {
	Divider(w, caps)
	if r.WhenLine != "" {
		fmt.Fprintln(w, caps.Palette.Dim+r.WhenLine+caps.Palette.Reset)
	}
	width := 0
	for _, row := range r.Rows {
		if l := len(row.Label); l > width {
			width = l
		}
	}
	if l := len(r.Result.Label); l > width {
		width = l
	}
	if width < 8 {
		width = 8
	}

	for _, row := range r.Rows {
		printDoctorRow(w, caps, width, row)
	}
	if r.Result.Label != "" {
		printDoctorRow(w, caps, width, r.Result)
	}

	for i, h := range r.Hints {
		col := caps.Palette.Yellow + caps.Palette.Bold
		fmt.Fprintf(w, "%s%s%s | %s\n",
			col, padLabel(fmt.Sprintf("Hint %d", i+1), width), caps.Palette.Reset, h)
	}
	Divider(w, caps)
}

func printDoctorRow(w io.Writer, caps Caps, width int, row DoctorRow) {
	col := caps.Palette.Reset
	switch row.Tone {
	case ToneOK:
		col = caps.Palette.Green
	case ToneWarn:
		col = caps.Palette.Yellow
	case ToneFail:
		col = caps.Palette.Red
	}
	icon := ""
	switch row.Tone {
	case ToneOK:
		icon = " " + caps.BannerSym.IconOK
	case ToneWarn:
		icon = " " + caps.BannerSym.IconWarn
	case ToneFail:
		icon = " " + caps.BannerSym.IconFail
	}
	fmt.Fprintf(w, "%s%s%s | %s%s%s\n",
		caps.Palette.Dim, padLabel(row.Label, width), caps.Palette.Reset,
		col, row.Value+icon, caps.Palette.Reset,
	)
}

func padLabel(s string, w int) string {
	if len(s) >= w {
		return s
	}
	return s + strings.Repeat(" ", w-len(s))
}

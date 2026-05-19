package ui

import (
	"fmt"
	"io"
	"strings"
)

// Tone names map to colour roles used across the UI.
type Tone string

const (
	ToneOK   Tone = "ok"
	ToneWarn Tone = "warn"
	ToneFail Tone = "fail"
	ToneDim  Tone = "dim"
)

// HealthDot is one entry in the health row.
type HealthDot struct {
	Name    string // "api", "auth", "skills", "mcp", "runner"
	Tone    Tone
	Updated bool // true => render an "updated this run" marker (⬆)
}

// PrintHealthRow renders "● api  ● auth  ⬆️ skills  ● mcp  ● runner".
// Dots whose Name is empty are skipped (so callers can elide e.g. "runner"
// when there is no runner data).
func PrintHealthRow(w io.Writer, caps Caps, dots []HealthDot) {
	pieces := make([]string, 0, len(dots))
	for _, d := range dots {
		if d.Name == "" {
			continue
		}
		pieces = append(pieces, buildDot(caps, d))
	}
	if len(pieces) == 0 {
		return
	}
	fmt.Fprintln(w, "  "+strings.Join(pieces, "  "))
}

func buildDot(caps Caps, d HealthDot) string {
	col := caps.Palette.Green + caps.Palette.Bold
	switch d.Tone {
	case ToneWarn:
		col = caps.Palette.Yellow + caps.Palette.Bold
	case ToneFail:
		col = caps.Palette.Red + caps.Palette.Bold
	case ToneDim:
		col = caps.Palette.Dim
	}
	glyph := caps.BannerSym.DotOK
	if d.Updated {
		glyph = caps.BannerSym.DotUp
	}
	return col + glyph + caps.Palette.Reset + " " + d.Name
}

// ConcurrentRow is the alternate single-row health display shown when the
// wrapper detected another instance was active and ran in read-only mode.
func PrintConcurrentRow(w io.Writer, caps Caps, note string) {
	col := caps.Palette.Yellow + caps.Palette.Bold
	if note == "" {
		note = "Using local auth.json."
	}
	fmt.Fprintln(w, "  "+col+caps.BannerSym.DotOK+caps.Palette.Reset+" concurrent  "+note)
}

// Result tagline drawn under the boot screen.
func PrintResult(w io.Writer, caps Caps, label string, tone Tone) {
	if label == "" {
		return
	}
	col := caps.Palette.Green + caps.Palette.Bold
	switch tone {
	case ToneWarn:
		col = caps.Palette.Yellow + caps.Palette.Bold
	case ToneFail:
		col = caps.Palette.Red + caps.Palette.Bold
	}
	fmt.Fprintln(w, "  "+col+label+caps.Palette.Reset)
}

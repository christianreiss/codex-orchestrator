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

// PrintHealthRow renders a shape-and-colour encoded health summary. Colour is
// never the only signal: OK, warning, and failure use different glyphs, while
// an update is a separate suffix that cannot hide a failure.
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
	glyph := toneSymbol(caps, d.Tone, false)
	result := col + glyph + caps.Palette.Reset + " " + CleanInline(d.Name)
	if d.Updated {
		result += caps.Palette.Dim + " " + toneSymbol(caps, ToneOK, true) + caps.Palette.Reset
	}
	return result
}

// ConcurrentRow is the alternate single-row health display shown when the
// wrapper detected another instance was active and paused managed sync writes.
func PrintConcurrentRow(w io.Writer, caps Caps, note string) {
	if note == "" {
		note = "Managed content sync paused; auth freshness remains active."
	}
	fmt.Fprintln(w, "  concurrent  "+CleanInline(note))
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
	fmt.Fprintln(w, "  "+col+toneSymbol(caps, tone, false)+" "+CleanInline(label)+caps.Palette.Reset)
}

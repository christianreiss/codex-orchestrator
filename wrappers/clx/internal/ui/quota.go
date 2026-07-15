package ui

import (
	"fmt"
	"io"
	"strings"
	"time"
)

// BarWidth is the visible width of a quota bar in cells.
const BarWidth = 24

// QuotaRow describes one quota bar (5h, weekly, daily allowance, …).
type QuotaRow struct {
	Label          string // "5h", "weekly", "⚡ 5h", …
	Used           int    // 0..100
	ResetAfter     time.Duration
	Lane           string // "normal" | "spark"  (informational)
	Note           string // free-form trailing dim text
	Projection     string // pre-rendered " ~100% in ~2d 5h, before reset" (red) when set
	ProjectionTone Tone   // dim for benign projections, warn/fail when thresholds are crossed
	WarnAtPct      int    // default 80
	BlockAtPct     int    // default 95
}

// PrintQuotaRow renders "  label   pct% [bar]  resetLabel  note".
func PrintQuotaRow(w io.Writer, caps Caps, row QuotaRow) {
	fmt.Fprintln(w, formatQuotaLine(caps, row, 80))
}

// formatQuotaLine adapts the graph to the available card width. Notes are
// useful on wide terminals but yield to the actual usage/reset values first.
func formatQuotaLine(caps Caps, row QuotaRow, width int) string {
	label := CleanInline(row.Label)
	if caps.Dumb || !caps.UTF8 {
		label = strings.ReplaceAll(label, "⚡", "spark")
	}
	labelWidth := 8
	if width < 54 {
		labelWidth = 6
	}
	label = TruncateText(label, labelWidth, caps)
	label = PadRight(label, labelWidth)

	pct := fmt.Sprintf("%3d%%", clampPct(row.Used))
	tone := classifyPct(row.Used, row.WarnAtPct, row.BlockAtPct)
	pctCol := tonePalette(caps, tone)
	resetTxt := ""
	if row.ResetAfter > 0 {
		resetTxt = "  " + DurationShort(row.ResetAfter)
	}
	barWidth := width - labelWidth - VisibleWidth(pct) - VisibleWidth(resetTxt) - 5
	if barWidth > BarWidth {
		barWidth = BarWidth
	}
	if barWidth < 6 {
		barWidth = 6
	}
	bar := buildBar(caps, row.Used, barWidth, row.WarnAtPct, row.BlockAtPct)
	line := fmt.Sprintf("%s  %s%s%s  %s%s",
		label,
		pctCol, pct, caps.Palette.Reset,
		bar,
		resetTxt,
	)

	note := row.Note
	if row.Projection != "" {
		note = row.Projection
	}
	remaining := width - VisibleWidth(line) - 2
	if note != "" && remaining >= 12 {
		note = TruncateText(note, remaining, caps)
		noteTone := ToneDim
		if row.Projection != "" && row.ProjectionTone != "" {
			noteTone = row.ProjectionTone
		}
		line += "  " + styleTone(caps, noteTone, note)
	}
	return line
}

// BuildBar renders the fill string with appropriate colour by saturation.
func BuildBar(caps Caps, pct int) string {
	return buildBar(caps, pct, BarWidth, 80, 95)
}

func buildBar(caps Caps, pct, width, warnAt, blockAt int) string {
	pct = clampPct(pct)
	if width < 1 {
		width = 1
	}
	filled := (pct*width + 50) / 100
	if filled > width {
		filled = width
	}
	tone := classifyPct(pct, warnAt, blockAt)
	col := tonePalette(caps, tone)
	return col + strings.Repeat(caps.BannerSym.BarFill, filled) + caps.Palette.Reset +
		caps.Palette.Dim + strings.Repeat(caps.BannerSym.BarEmpty, width-filled) + caps.Palette.Reset
}

// QuotaReasonRow prints a ⚠ or ⛔ note line in yellow/red.
func PrintQuotaReason(w io.Writer, caps Caps, sym, text string, tone Tone) {
	col := tonePalette(caps, tone)
	icon := sym
	switch tone {
	case ToneWarn:
		if sym == "" {
			icon = caps.BannerSym.IconWarn
		}
	case ToneFail:
		if sym == "" {
			icon = caps.BannerSym.IconFail
		}
	}
	fmt.Fprintln(w, "  "+col+icon+" "+text+caps.Palette.Reset)
}

func clampPct(v int) int {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func classifyPct(pct, warn, block int) Tone {
	if warn == 0 {
		warn = 80
	}
	if block == 0 {
		block = 95
	}
	if pct >= block {
		return ToneFail
	}
	if pct >= warn {
		return ToneWarn
	}
	return ToneOK
}

func tonePalette(caps Caps, tone Tone) string {
	switch tone {
	case ToneWarn:
		return caps.Palette.Orange + caps.Palette.Bold
	case ToneFail:
		return caps.Palette.Red + caps.Palette.Bold
	case ToneDim:
		return caps.Palette.Dim
	default:
		return caps.Palette.Green + caps.Palette.Bold
	}
}

// ProjectUsage extrapolates current %used to the end of the reset window.
// Returns the projected end-of-window % (may be > 100).
//
// elapsed = limitSeconds - resetAfterSeconds (clamped to >= 1).
// rate    = used/elapsed.
// projected = used + rate*resetAfter.
func ProjectUsage(used int, limitSeconds, resetAfterSeconds int64) int {
	if used <= 0 || limitSeconds <= 0 || resetAfterSeconds <= 0 {
		return used
	}
	elapsed := limitSeconds - resetAfterSeconds
	if elapsed < 1 {
		elapsed = 1
	}
	rate := float64(used) / float64(elapsed)
	return int(float64(used) + rate*float64(resetAfterSeconds))
}

// ProjectETA returns the time-to-100% at the current burn rate, only if
// projection >= 100. Returns 0 when not applicable.
func ProjectETA(used int, limitSeconds, resetAfterSeconds int64) time.Duration {
	if used <= 0 || used >= 100 || limitSeconds <= 0 || resetAfterSeconds <= 0 {
		return 0
	}
	projected := ProjectUsage(used, limitSeconds, resetAfterSeconds)
	if projected < 100 {
		return 0
	}
	elapsed := limitSeconds - resetAfterSeconds
	if elapsed < 1 {
		elapsed = 1
	}
	rate := float64(used) / float64(elapsed)
	if rate <= 0 {
		return 0
	}
	remaining := float64(100 - used)
	secsToHit := remaining / rate
	return time.Duration(secsToHit) * time.Second
}

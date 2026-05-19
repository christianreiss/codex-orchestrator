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
	Label       string // "5h", "weekly", "⚡ 5h", …
	Used        int    // 0..100
	ResetAfter  time.Duration
	Lane        string // "normal" | "spark"  (informational)
	Note        string // free-form trailing dim text
	Projection  string // pre-rendered " ~100% in ~2d 5h, before reset" (red) when set
	WarnAtPct   int    // default 80
	BlockAtPct  int    // default 95
}

// PrintQuotaRow renders "  label   pct% [bar]  resetLabel  note".
func PrintQuotaRow(w io.Writer, caps Caps, row QuotaRow) {
	bar := BuildBar(caps, row.Used)
	pct := fmt.Sprintf("%3d%%", clampPct(row.Used))
	tone := classifyPct(row.Used, row.WarnAtPct, row.BlockAtPct)
	pctCol := tonePalette(caps, tone)
	resetTxt := ""
	if row.ResetAfter > 0 {
		resetTxt = "  " + DurationShort(row.ResetAfter)
	}
	note := row.Note
	if row.Projection != "" {
		note = row.Projection
	}
	pad := PadRight(row.Label, 8)
	fmt.Fprintf(w, "  %s %s%s%s [%s]%s",
		pad,
		pctCol, pct, caps.Palette.Reset,
		bar,
		resetTxt,
	)
	if note != "" {
		fmt.Fprintf(w, "  %s%s%s", caps.Palette.Dim, note, caps.Palette.Reset)
	}
	fmt.Fprintln(w)
}

// BuildBar renders the fill string with appropriate colour by saturation.
func BuildBar(caps Caps, pct int) string {
	pct = clampPct(pct)
	filled := (pct*BarWidth + 50) / 100
	if filled > BarWidth {
		filled = BarWidth
	}
	tone := classifyPct(pct, 80, 95)
	col := tonePalette(caps, tone)
	return col + strings.Repeat(caps.BannerSym.BarFill, filled) + caps.Palette.Reset +
		caps.Palette.Dim + strings.Repeat(caps.BannerSym.BarEmpty, BarWidth-filled) + caps.Palette.Reset
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

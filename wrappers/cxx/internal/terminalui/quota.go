package terminalui

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
	Stale          bool   // Last reported values are context, not a current verdict.
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

// PrintQuotaRow renders one responsive quota row. Forecast/detail text stays
// inline when it fits and reflows onto indented continuation lines otherwise.
func PrintQuotaRow(w io.Writer, caps Caps, row QuotaRow) {
	for _, line := range formatQuotaLines(caps, row, 80) {
		fmt.Fprintln(w, line)
	}
}

// formatQuotaLines adapts the graph to the available width. Usage and reset
// remain on the primary line; a forecast that cannot fit in full moves to a
// semantic, width-bounded continuation line instead of being ellipsized.
func formatQuotaLines(caps Caps, row QuotaRow, width int) []string {
	label := CleanInline(row.Label)
	if caps.Dumb || !caps.UTF8 {
		label = strings.ReplaceAll(label, "⚡", "spark")
	}
	labelWidth := 10
	if width < 54 {
		labelWidth = 6
	}
	lines := []string{}
	if VisibleWidth(label) > labelWidth {
		// Preserve distinct window names (notably Spark weekly) in narrow
		// layouts instead of making different quotas share an ellipsis.
		lines = append(lines, WrapText(label, width)...)
		label = ""
	}
	label = PadRight(label, labelWidth)

	pct := fmt.Sprintf("%3d%%", clampPct(row.Used))
	tone := classifyPct(row.Used, row.WarnAtPct, row.BlockAtPct)
	if row.Stale {
		tone = ToneDim
		caps.Palette.Green = caps.Palette.Dim
		caps.Palette.Yellow = caps.Palette.Dim
		caps.Palette.Orange = caps.Palette.Dim
		caps.Palette.Red = caps.Palette.Dim
		caps.Palette.Bold = ""
	}
	pctCol := tonePalette(caps, tone)
	resetTxt := ""
	if row.ResetAfter > 0 {
		resetTxt = "  reset " + DurationShort(row.ResetAfter)
	}
	barWidth := width - labelWidth - VisibleWidth(pct) - VisibleWidth(resetTxt) - 5
	if barWidth > 42 {
		barWidth = 42
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

	note := CleanInline(row.Note)
	noteTone := ToneDim
	if row.Projection != "" {
		note = "forecast " + CleanInline(row.Projection)
		if row.ProjectionTone != "" {
			noteTone = row.ProjectionTone
		}
	}
	if row.Stale {
		noteTone = ToneDim
		if note == "" {
			note = "last reported; awaiting refresh"
		}
	}
	if note == "" {
		return append(lines, line)
	}

	marker := ""
	if row.Projection != "" && (noteTone == ToneWarn || noteTone == ToneFail) {
		// A forecast is advisory even when it crosses the configured limit:
		// use an attention marker, not a current-failure cross. The forecast
		// text itself retains its stronger colour when colour is available.
		marker = styleTone(caps, ToneWarn, toneSymbol(caps, ToneWarn, false)) + " "
	}
	decorated := marker + styleTone(caps, noteTone, note)
	remaining := width - VisibleWidth(line) - 2
	if remaining >= 12 && VisibleWidth(decorated) <= remaining {
		return append(lines, line+"  "+decorated)
	}

	indentWidth := labelWidth + 2
	if indentWidth >= width {
		indentWidth = 0
	}
	textWidth := width - indentWidth - VisibleWidth(marker)
	if textWidth < 1 {
		textWidth = 1
	}
	lines = append(lines, line)
	indent := strings.Repeat(" ", indentWidth)
	for i, wrapped := range WrapText(note, textWidth) {
		lineMarker := marker
		if i > 0 {
			lineMarker = strings.Repeat(" ", VisibleWidth(marker))
		}
		lines = append(lines, indent+lineMarker+styleTone(caps, noteTone, wrapped))
	}
	return lines
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
// Projection is suppressed until at least five minutes and 1% of the window
// have elapsed; a first telemetry sample is not a burn-rate trend.
// elapsed = limitSeconds - resetAfterSeconds.
// rate    = used/elapsed.
// projected = used + rate*resetAfter.
func ProjectUsage(used int, limitSeconds, resetAfterSeconds int64) int {
	if used <= 0 || limitSeconds <= 0 || resetAfterSeconds <= 0 {
		return used
	}
	if !ProjectionReady(limitSeconds, resetAfterSeconds) {
		return used
	}
	elapsed := limitSeconds - resetAfterSeconds
	rate := float64(used) / float64(elapsed)
	return int(float64(used) + rate*float64(resetAfterSeconds))
}

// ProjectionReady rejects near-fresh windows where a single percent consumed
// over seconds would extrapolate into a meaningless alarm.
func ProjectionReady(limitSeconds, resetAfterSeconds int64) bool {
	if limitSeconds <= 0 || resetAfterSeconds <= 0 {
		return false
	}
	elapsed := limitSeconds - resetAfterSeconds
	minimum := limitSeconds / 100
	if minimum < int64(5*time.Minute/time.Second) {
		minimum = int64(5 * time.Minute / time.Second)
	}
	return elapsed >= minimum
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
	rate := float64(used) / float64(elapsed)
	if rate <= 0 {
		return 0
	}
	remaining := float64(100 - used)
	secsToHit := remaining / rate
	return time.Duration(secsToHit) * time.Second
}

// QuotaCompare is one provider row of a side-by-side quota comparison.
type QuotaCompare struct {
	Label     string
	Used      int           // 0..100
	Projected int           // estimated % at reset; 0 = no forecast
	Window    time.Duration // 0 = unknown
	ResetIn   time.Duration // 0 = unknown
	Age       time.Duration // time since the measurement
}

// QuotaCompareLines renders aligned bar rows for comparing providers:
//
//	OpenAI (cdx)  ━━━━━━━━━━━━━━━━━━━─  94%  7d window · reset unknown · 12m ago
//	Claude (clx)  ━━━━━━━─────────────  35%  7d window · reset unknown · 1m ago
//
// The bar shrinks to fit width; metadata that still does not fit moves to an
// indented continuation lines. Callers use this only on rich destinations.
func QuotaCompareLines(caps Caps, rows []QuotaCompare, width int) []string {
	p := caps.Palette
	labelWidth := 0
	sep := p.Dim + " · " + p.Reset
	if !caps.UTF8 || caps.Dumb {
		sep = p.Dim + " - " + p.Reset
	}
	metas := make([][]string, len(rows))
	metaWidth := 0
	for i, r := range rows {
		labelWidth = max(labelWidth, VisibleWidth(inlineFor(caps, r.Label)))
		metas[i] = r.meta(caps)
		metaWidth = max(metaWidth, VisibleWidth(strings.Join(metas[i], sep)))
	}
	// label + gap + bar + gap + "100%" + gap + meta
	barWidth := min(max(width-labelWidth-metaWidth-10, 10), 20)
	// The head row (label, bar, percentage) must fit on its own; on narrow
	// terminals the bar shrinks and finally disappears rather than overflow.
	barWidth = min(barWidth, width-labelWidth-8)
	lines := make([]string, 0, len(rows))
	for i, r := range rows {
		pct := fmt.Sprintf("%3d%%", clampPct(r.Used))
		bar := ""
		if barWidth >= 3 {
			bar = buildBar(caps, r.Used, barWidth, 0, 0) + "  "
		}
		head := p.Bold + PadRight(inlineFor(caps, r.Label), labelWidth) + p.Reset + "  " +
			bar + tonePalette(caps, classifyPct(r.Used, 0, 0)) + pct + p.Reset
		if meta := strings.Join(metas[i], sep); VisibleWidth(head)+2+VisibleWidth(meta) <= width {
			lines = append(lines, head+"  "+meta)
			continue
		}
		lines = append(lines, head)
		// Hang metadata under the bar, unless a single part would then overflow
		// a narrow terminal; drop the indent first, truncate as a last resort.
		hang := labelWidth + 2
		for _, part := range metas[i] {
			if hang+VisibleWidth(part) > width {
				hang = 0
			}
		}
		indent := strings.Repeat(" ", hang)
		cur := ""
		for _, part := range metas[i] {
			if VisibleWidth(part) > width {
				part = TruncateText(part, width, caps)
			}
			if cur != "" && hang+VisibleWidth(cur+sep+part) > width {
				lines = append(lines, indent+cur)
				cur = ""
			}
			if cur != "" {
				cur += sep
			}
			cur += part
		}
		lines = append(lines, indent+cur)
	}
	return lines
}

func (r QuotaCompare) meta(caps Caps) []string {
	p := caps.Palette
	var parts []string
	if r.Window > 0 {
		parts = append(parts, p.Dim+DurationShort(r.Window)+" window"+p.Reset)
	}
	if r.Projected > 0 {
		tone := ToneDim
		if r.Projected >= 100 {
			tone = ToneWarn
		}
		parts = append(parts, styleTone(caps, tone, fmt.Sprintf("~%d%% at reset", r.Projected)))
	}
	reset := "reset unknown"
	if r.ResetIn > 0 {
		reset = "resets in " + DurationShort(r.ResetIn)
	}
	parts = append(parts, p.Dim+reset+p.Reset, p.Dim+DurationShort(r.Age)+" ago"+p.Reset)
	return parts
}

package ui

import (
	"fmt"
	"io"
	"os"
	"strings"
)

const minRichColumns = 40

// ScreenInput is the complete, presentation-neutral state of one cdx startup
// or status request. Missing values degrade cleanly.
type ScreenInput struct {
	WrapperVersion string
	WrapperTone    Tone
	WrapperTarget  string

	CodexVersion string
	CodexTone    Tone
	CodexTarget  string

	HostFQDN  string
	Insecure  bool
	BrowserOS bool
	Model     string
	Effort    string
	Lane      string
	APICalls  int64

	Concurrent     bool
	ConcurrentNote string
	Dots           []HealthDot

	QuotaRows   []QuotaRow
	QuotaWarn   string
	QuotaBlock  string
	SessionRows []SessionRow

	ResultLabel string
	ResultTone  Tone
	Theme       string
}

type SessionRow struct {
	Label string
	Count int64
}

// PrintBootScreen chooses rich TTY or compact log-safe output once, based on
// the destination stream rather than process stderr.
func PrintBootScreen(w io.Writer, in ScreenInput) {
	caps := DetectCapsFor(w, in.Theme)
	printBootScreen(w, in, caps)
}

func printBootScreen(w io.Writer, in ScreenInput, caps Caps) {
	if !caps.IsTTY || caps.Dumb || caps.Columns < minRichColumns || os.Getenv("CDX_SKIP_BANNER") == "1" {
		PrintMinimalScreen(w, in)
		return
	}

	resultTone := in.ResultTone
	if resultTone == "" {
		resultTone = ToneOK
	}
	if in.Concurrent && resultTone != ToneFail {
		resultTone = ToneWarn
	}

	c := newCard(w, caps)
	accent := caps.BannerColor()
	reset := caps.Palette.Reset
	brand := accent + "CDX" + reset + "  " + caps.Palette.Bold + "CODEX ORCHESTRATOR" + reset
	outcome := strings.ToUpper(toneWord(resultTone))
	if in.Concurrent && resultTone != ToneFail {
		outcome = "READ ONLY"
	}
	outcome = styleTone(caps, resultTone, outcome)

	c.top()
	c.line(joinSides(brand, outcome, c.inner, caps))
	meta := renderContext(in)
	if len(meta) == 0 {
		meta = []string{"managed Codex session"}
	}
	for _, line := range packSeparatedPieces(meta, c.inner, richSeparator(caps)) {
		c.line(caps.Palette.Dim + line + reset)
	}

	c.divider("system")
	versions := []string{
		versionPiece(caps, "codex", in.CodexVersion, in.CodexTarget, in.CodexTone),
		versionPiece(caps, "wrapper", in.WrapperVersion, in.WrapperTarget, in.WrapperTone),
	}
	for _, line := range packPieces(versions, c.inner, 4) {
		c.line(line)
	}
	if in.Concurrent {
		renderToneText(c, ToneWarn, strOr(in.ConcurrentNote, "Using local state; sync writes are paused."))
	} else {
		health := make([]string, 0, len(in.Dots))
		for _, dot := range in.Dots {
			if dot.Name != "" {
				health = append(health, buildDot(caps, dot))
			}
		}
		for _, line := range packPieces(health, c.inner, 3) {
			c.line(line)
		}
	}

	if len(in.QuotaRows) > 0 || in.QuotaWarn != "" || in.QuotaBlock != "" {
		c.divider("quota")
		for _, row := range in.QuotaRows {
			c.line(formatQuotaLine(caps, row, c.inner))
		}
		if in.QuotaWarn != "" {
			renderToneText(c, ToneWarn, in.QuotaWarn)
		}
		if in.QuotaBlock != "" {
			renderToneText(c, ToneFail, in.QuotaBlock)
		}
	}

	if len(in.SessionRows) > 0 {
		c.divider("sessions")
		pieces := make([]string, 0, len(in.SessionRows))
		for _, row := range in.SessionRows {
			pieces = append(pieces,
				caps.Palette.Dim+CleanInline(row.Label)+reset+" "+caps.Palette.Bold+GroupedInt(row.Count)+reset,
			)
		}
		for _, line := range packPieces(pieces, c.inner, 4) {
			c.line(line)
		}
	}

	c.divider("")
	renderToneText(c, resultTone, in.ResultLabel)
	c.bottom()
}

func renderContext(in ScreenInput) []string {
	parts := []string{}
	if in.HostFQDN != "" {
		parts = append(parts, CleanInline(in.HostFQDN))
	}
	if in.Insecure {
		parts = append(parts, "insecure host")
	} else if in.HostFQDN != "" {
		parts = append(parts, "secure")
	}
	if in.Lane != "" {
		parts = append(parts, CleanInline(in.Lane)+" lane")
	}
	model := CleanInline(in.Model)
	if effort := CleanInline(in.Effort); model != "" && effort != "" {
		model += "/" + effort
	}
	if model != "" {
		parts = append(parts, model)
	}
	if in.BrowserOS {
		parts = append(parts, "BrowserOS")
	}
	if in.APICalls > 0 {
		parts = append(parts, CompactNumber(in.APICalls)+" calls")
	}
	return parts
}

func versionPiece(caps Caps, label, current, target string, tone Tone) string {
	if tone == "" {
		tone = ToneOK
	}
	current = strOr(CleanInline(current), "—")
	value := current
	if target = CleanInline(target); target != "" && tone != ToneOK {
		arrow := "→"
		if caps.Dumb || !caps.UTF8 {
			arrow = "->"
		}
		value += " " + arrow + " " + target
	}
	return styleTone(caps, tone, toneSymbol(caps, tone, false)) + " " +
		caps.Palette.Dim + label + caps.Palette.Reset + " " + value
}

func renderToneText(c card, tone Tone, text string) {
	text = CleanInline(text)
	if text == "" {
		return
	}
	symbol := toneSymbol(c.caps, tone, false)
	prefix := symbol + " "
	available := c.inner - VisibleWidth(prefix)
	if available < 1 {
		available = 1
	}
	lines := WrapText(text, available)
	for i, line := range lines {
		if i == 0 {
			c.line(styleTone(c.caps, tone, prefix+line))
		} else {
			c.line(strings.Repeat(" ", VisibleWidth(prefix)) + styleTone(c.caps, tone, line))
		}
	}
}

func richSeparator(caps Caps) string {
	if caps.Dumb || !caps.UTF8 {
		return " | "
	}
	return "  ·  "
}

// PrintMinimalScreen is deterministic, ANSI-free, and suitable for pipes,
// cron logs, dumb terminals, and the explicit --minimal mode.
func PrintMinimalScreen(w io.Writer, in ScreenInput) {
	tone := in.ResultTone
	if tone == "" {
		tone = ToneOK
	}
	if in.Concurrent && tone != ToneFail {
		tone = ToneWarn
	}
	fields := []string{"status=" + toneWord(tone)}
	if in.HostFQDN != "" {
		fields = append(fields, "host="+PlainInline(in.HostFQDN))
	}
	fields = append(fields,
		"codex="+minimalVersion(in.CodexVersion, in.CodexTarget),
		"wrapper="+minimalVersion(in.WrapperVersion, in.WrapperTarget),
	)
	if in.Lane != "" {
		fields = append(fields, "lane="+PlainInline(in.Lane))
	}
	if in.Model != "" {
		model := PlainInline(in.Model)
		if in.Effort != "" {
			model += "/" + PlainInline(in.Effort)
		}
		fields = append(fields, "model="+model)
	}
	if in.BrowserOS {
		fields = append(fields, "browseros=enabled")
	}
	if in.Insecure {
		fields = append(fields, "security=insecure")
	}
	if in.APICalls > 0 {
		fields = append(fields, "calls="+GroupedInt(in.APICalls))
	}
	fmt.Fprintln(w, "cdx | "+strings.Join(fields, " | "))

	if len(in.Dots) > 0 {
		health := make([]string, 0, len(in.Dots))
		for _, dot := range in.Dots {
			if dot.Name != "" {
				health = append(health, PlainInline(dot.Name)+"="+healthWord(dot))
			}
		}
		fmt.Fprintln(w, "health | "+strings.Join(health, " | "))
	}
	for _, row := range in.QuotaRows {
		reset := ""
		if row.ResetAfter > 0 {
			reset = " | reset=" + DurationShort(row.ResetAfter)
		}
		fmt.Fprintf(w, "quota | %s=%d%%%s\n", PlainInline(row.Label), clampPct(row.Used), reset)
	}
	if len(in.SessionRows) > 0 {
		parts := make([]string, 0, len(in.SessionRows))
		for _, row := range in.SessionRows {
			parts = append(parts, PlainInline(row.Label)+"="+GroupedInt(row.Count))
		}
		fmt.Fprintln(w, "sessions | "+strings.Join(parts, " | "))
	}
	if in.ConcurrentNote != "" && in.Concurrent {
		fmt.Fprintln(w, "warning | "+PlainInline(in.ConcurrentNote))
	}
	if in.QuotaWarn != "" {
		fmt.Fprintln(w, "warning | "+PlainInline(in.QuotaWarn))
	}
	if in.QuotaBlock != "" {
		fmt.Fprintln(w, "blocked | "+PlainInline(in.QuotaBlock))
	}
	if in.ResultLabel != "" {
		fmt.Fprintln(w, "result | "+PlainInline(in.ResultLabel))
	}
}

func minimalVersion(current, target string) string {
	current = strOr(PlainInline(current), "unknown")
	target = PlainInline(target)
	if target != "" && target != current {
		return current + "->" + target
	}
	return current
}

func healthWord(dot HealthDot) string {
	if dot.Updated && dot.Tone == ToneOK {
		return "updated"
	}
	switch dot.Tone {
	case ToneWarn:
		return "warn"
	case ToneFail:
		return "fail"
	case ToneDim:
		return "unknown"
	default:
		return "ok"
	}
}

func strOr(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

package ui

import (
	"io"
	"os"
	"strings"
)

const minRichColumns = 40

type ScreenInput struct {
	WrapperVersion string
	WrapperTone    Tone
	WrapperTarget  string

	ClaudeVersion string
	ClaudeTone    Tone
	ClaudeTarget  string

	HostFQDN string
	Insecure bool
	Model    string
	Effort   string
	APICalls int64

	Concurrent        bool
	ConcurrentNote    string
	BypassPermissions bool
	Dots              []HealthDot
	SessionRows       []SessionRow

	ResultLabel string
	ResultTone  Tone
	Theme       string
}

type SessionRow struct {
	Label string
	Count int64
}

func PrintBootScreen(w io.Writer, in ScreenInput) {
	caps := DetectCapsFor(w, in.Theme)
	printBootScreen(w, in, caps)
}

func printBootScreen(w io.Writer, in ScreenInput, caps Caps) {
	if !caps.IsTTY || caps.Dumb || caps.Columns < minRichColumns || os.Getenv("CLX_SKIP_BANNER") == "1" {
		printMinimalScreen(w, in, caps)
		return
	}

	resultTone := in.ResultTone
	if resultTone == "" {
		resultTone = ToneOK
	}
	if in.BypassPermissions && resultTone != ToneFail {
		resultTone = ToneWarn
	}

	c := newCard(w, caps)
	accent := caps.BannerColor()
	reset := caps.Palette.Reset
	brand := accent + "CLX" + reset + "  " + caps.Palette.Bold + "CODEX ORCHESTRATOR" + reset
	outcome := strings.ToUpper(toneWord(resultTone))
	if in.Concurrent {
		outcome = "SYNC PAUSED"
	} else {
		outcome = styleTone(caps, resultTone, outcome)
	}

	c.top()
	c.line(joinSides(brand, outcome, c.inner, caps))
	meta := renderContext(in)
	if len(meta) == 0 {
		meta = []string{"managed Claude session"}
	}
	for _, line := range packSeparatedPieces(meta, c.inner, richSeparator(caps)) {
		c.line(caps.Palette.Dim + line + reset)
	}

	c.divider("system")
	versions := []string{
		versionPiece(caps, "claude", in.ClaudeVersion, in.ClaudeTarget, in.ClaudeTone),
		versionPiece(caps, "wrapper", in.WrapperVersion, in.WrapperTarget, in.WrapperTone),
	}
	for _, line := range packPieces(versions, c.inner, 4) {
		c.line(line)
	}
	if in.Concurrent {
		renderPlainText(c, strOr(in.ConcurrentNote, "Managed content sync paused; auth freshness remains active."))
	}
	health := make([]string, 0, len(in.Dots))
	for _, dot := range in.Dots {
		if dot.Name != "" {
			health = append(health, buildDot(caps, dot))
		}
	}
	for _, line := range packPieces(health, c.inner, 3) {
		c.line(line)
	}
	if len(in.SessionRows) > 0 {
		c.divider("activity")
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

	if in.BypassPermissions {
		c.divider("security")
		renderToneText(c, ToneWarn, "Bypass permissions active for this run.")
	}

	if !concurrentResultAlreadyShown(in) {
		c.divider("")
		renderToneTextLimited(c, resultTone, in.ResultLabel, 3)
	}
	c.bottom()
}

// concurrentResultAlreadyShown avoids repeating the exact pause explanation in
// both SYSTEM and the result footer. Distinct concurrent errors still retain a
// result footer so the important outcome is never hidden.
func concurrentResultAlreadyShown(in ScreenInput) bool {
	if !in.Concurrent {
		return false
	}
	note := strOr(in.ConcurrentNote, "Managed content sync paused; auth freshness remains active.")
	return CleanInline(in.ResultLabel) == CleanInline(note)
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
	model := CleanInline(in.Model)
	effort := CleanInline(in.Effort)
	if model != "" && effort != "" {
		model += "/" + effort
	}
	if model != "" {
		parts = append(parts, model)
	} else if effort != "" {
		parts = append(parts, "effort "+effort)
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
	renderToneTextLimited(c, tone, text, 0)
}

func renderPlainText(c card, text string) {
	for _, line := range WrapText(CleanInline(text), c.inner) {
		c.line(line)
	}
}

func renderToneTextLimited(c card, tone Tone, text string, maxLines int) {
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
	lines := limitWrappedLines(WrapText(text, available), maxLines, available, c.caps)
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

func PrintMinimalScreen(w io.Writer, in ScreenInput) {
	printMinimalScreen(w, in, DetectCapsFor(w, in.Theme))
}

func printMinimalScreen(w io.Writer, in ScreenInput, caps Caps) {
	tone := in.ResultTone
	if tone == "" {
		tone = ToneOK
	}
	if in.BypassPermissions && tone != ToneFail {
		tone = ToneWarn
	}
	fields := []string{"status=" + toneWord(tone)}
	if in.HostFQDN != "" {
		fields = append(fields, "host="+PlainInline(in.HostFQDN))
	}
	fields = append(fields,
		"claude="+minimalVersion(in.ClaudeVersion, in.ClaudeTarget),
		"wrapper="+minimalVersion(in.WrapperVersion, in.WrapperTarget),
	)
	if in.Model != "" {
		model := PlainInline(in.Model)
		if in.Effort != "" {
			model += "/" + PlainInline(in.Effort)
		}
		fields = append(fields, "model="+model)
	} else if in.Effort != "" {
		fields = append(fields, "effort="+PlainInline(in.Effort))
	}
	if in.Insecure {
		fields = append(fields, "security=insecure")
	}
	if in.APICalls > 0 {
		fields = append(fields, "calls="+GroupedInt(in.APICalls))
	}
	printPlainLine(w, caps, "clx | "+strings.Join(fields, " | "))

	if len(in.Dots) > 0 {
		health := make([]string, 0, len(in.Dots))
		for _, dot := range in.Dots {
			if dot.Name != "" {
				health = append(health, PlainInline(dot.Name)+"="+healthWord(dot))
			}
		}
		printPlainLine(w, caps, "health | "+strings.Join(health, " | "))
	}
	if len(in.SessionRows) > 0 {
		parts := make([]string, 0, len(in.SessionRows))
		for _, row := range in.SessionRows {
			parts = append(parts, PlainInline(row.Label)+"="+GroupedInt(row.Count))
		}
		printPlainLine(w, caps, "activity | "+strings.Join(parts, " | "))
	}
	if in.BypassPermissions {
		printPlainLine(w, caps, "warning | bypass permissions active (--dangerously-skip-permissions)")
	}
	if in.ConcurrentNote != "" && in.Concurrent {
		printPlainLine(w, caps, "notice | "+PlainInline(in.ConcurrentNote))
	}
	if in.ResultLabel != "" {
		printPlainLineLimited(w, caps, "result | "+PlainInline(in.ResultLabel), 3)
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

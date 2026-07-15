package ui

import (
	"fmt"
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

	ResultLabel string
	ResultTone  Tone
	Theme       string
}

func PrintBootScreen(w io.Writer, in ScreenInput) {
	caps := DetectCapsFor(w, in.Theme)
	printBootScreen(w, in, caps)
}

func printBootScreen(w io.Writer, in ScreenInput, caps Caps) {
	if !caps.IsTTY || caps.Dumb || caps.Columns < minRichColumns || os.Getenv("CLX_SKIP_BANNER") == "1" {
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
	if in.BypassPermissions && resultTone != ToneFail {
		resultTone = ToneWarn
	}

	c := newCard(w, caps)
	accent := caps.BannerColor()
	reset := caps.Palette.Reset
	brand := accent + "CLX" + reset + "  " + caps.Palette.Bold + "CODEX ORCHESTRATOR" + reset
	outcome := strings.ToUpper(toneWord(resultTone))
	if in.Concurrent && resultTone != ToneFail {
		outcome = "READ ONLY"
	}
	outcome = styleTone(caps, resultTone, outcome)

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

	if in.BypassPermissions {
		c.divider("security")
		renderToneText(c, ToneFail, "Bypass permissions active for this run.")
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
	model := CleanInline(in.Model)
	if effort := CleanInline(in.Effort); model != "" && effort != "" {
		model += "/" + effort
	}
	if model != "" {
		parts = append(parts, model)
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

func PrintMinimalScreen(w io.Writer, in ScreenInput) {
	tone := in.ResultTone
	if tone == "" {
		tone = ToneOK
	}
	if in.Concurrent && tone != ToneFail {
		tone = ToneWarn
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
	}
	if in.Insecure {
		fields = append(fields, "security=insecure")
	}
	if in.APICalls > 0 {
		fields = append(fields, "calls="+GroupedInt(in.APICalls))
	}
	fmt.Fprintln(w, "clx | "+strings.Join(fields, " | "))

	if len(in.Dots) > 0 {
		health := make([]string, 0, len(in.Dots))
		for _, dot := range in.Dots {
			if dot.Name != "" {
				health = append(health, PlainInline(dot.Name)+"="+healthWord(dot))
			}
		}
		fmt.Fprintln(w, "health | "+strings.Join(health, " | "))
	}
	if in.BypassPermissions {
		fmt.Fprintln(w, "warning | bypass permissions active (--dangerously-skip-permissions)")
	}
	if in.ConcurrentNote != "" && in.Concurrent {
		fmt.Fprintln(w, "warning | "+PlainInline(in.ConcurrentNote))
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

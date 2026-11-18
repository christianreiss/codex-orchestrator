package terminalui

import (
	"fmt"
	"io"
	"strings"
)

const MinRichColumns = 40
const minRichColumns = MinRichColumns

// ScreenInput is the complete, presentation-neutral state of one cdx startup
// or status request. Missing values degrade cleanly.
type ScreenInput struct {
	SkipBanner        bool
	Prefix            string
	EngineName        string
	BypassPermissions bool
	WrapperVersion    string
	WrapperTone       Tone
	WrapperTarget     string

	EngineVersion string
	EngineTone    Tone
	EngineTarget  string

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
	QuotaNote   string
	QuotaWarn   string
	QuotaBlock  string
	SessionRows []SessionRow

	ResultLabel string
	ResultTone  Tone
	Theme       string

	Launch LaunchInfo
}

// LaunchInfo carries the launch facts that used to print as loose lines around
// the card (provider account, fleet session name, model policy rewrite, host
// daemon and communicator state). Every field is optional.
type LaunchInfo struct {
	Account      string
	Session      string
	PolicyFrom   string // model before the fleet policy rewrite; shown only when it differs
	Communicator string
	Dots         []HealthDot
	Problems     []string // warning lines shown above the result; escalate an OK card to warning
}

// AddDot appends a launch health dot; an empty name is ignored.
func (l *LaunchInfo) AddDot(name string, tone Tone, updated bool) {
	if strings.TrimSpace(name) == "" {
		return
	}
	l.Dots = append(l.Dots, HealthDot{Name: name, Tone: tone, Updated: updated})
}

// AddProblem records a warning shown inside the card.
func (l *LaunchInfo) AddProblem(text string) {
	if text = strings.TrimSpace(text); text != "" {
		l.Problems = append(l.Problems, text)
	}
}

// applyLaunch folds launch dots into the health row and escalates an OK
// verdict when a launch component reported a problem.
func applyLaunch(in ScreenInput) ScreenInput {
	if len(in.Launch.Dots) > 0 {
		in.Dots = append(append([]HealthDot(nil), in.Dots...), in.Launch.Dots...)
	}
	if len(in.Launch.Problems) > 0 && (in.ResultTone == "" || in.ResultTone == ToneOK) {
		// The success label would contradict the problem lines below it.
		in.ResultTone, in.ResultLabel = ToneWarn, ""
	}
	return in
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
	in = applyLaunch(normalizeScreen(in))
	caps = engineCaps(caps, in.Prefix)
	if !caps.IsTTY || caps.Dumb || caps.Columns < minRichColumns || in.SkipBanner {
		printMinimalScreen(w, in, caps)
		return
	}

	resultTone := in.ResultTone
	if resultTone == "" {
		resultTone = ToneOK
	}
	c := newFrame(w, caps)
	accent := caps.BannerColor()
	reset := caps.Palette.Reset
	brand := accent + strings.ToUpper(in.Prefix) + reset + caps.Palette.Dim + "  /  " + reset + caps.Palette.Bold + strings.ToUpper(in.EngineName) + reset
	outcome := strings.ToUpper(toneWord(resultTone))
	if in.BypassPermissions && resultTone != ToneFail {
		resultTone = ToneWarn
		outcome = strings.ToUpper(toneWord(resultTone))
	}
	if in.Concurrent && resultTone != ToneFail {
		outcome = "SYNC PAUSED"
	} else {
		outcome = styleTone(caps, resultTone, caps.BannerSym.DotOK+" "+outcome)
	}

	c.top()
	c.line(joinSides(brand, outcome, c.inner, caps))
	subtitle := caps.Palette.Dim + "CODEX ORCHESTRATOR" + reset
	if session := CleanInline(in.Launch.Session); session != "" {
		c.line(joinSides(subtitle, caps.Palette.Dim+"session "+reset+caps.Palette.Bold+session+reset, c.inner, caps))
	} else {
		c.line(subtitle)
	}
	c.line("")
	model := CleanInline(in.Model)
	if model != "" {
		if in.Effort != "" {
			model += "/" + CleanInline(in.Effort)
		}
		lines := WrapText(model, c.inner)
		policy := policyNote(in)
		for i, line := range lines {
			text := caps.Palette.Bold + line + reset
			if i == len(lines)-1 && policy != "" && VisibleWidth(line)+2+VisibleWidth(policy) <= c.inner {
				text += "  " + caps.Palette.Dim + policy + reset
				policy = ""
			}
			c.line(text)
		}
		if policy != "" {
			renderToneText(c, ToneDim, policy)
		}
	} else if in.Effort != "" {
		c.line(caps.Palette.Bold + "effort " + CleanInline(in.Effort) + reset)
	}
	context := in
	context.Model, context.Effort = "", ""
	meta := renderContext(context)
	if len(meta) == 0 && model == "" {
		meta = []string{"managed " + in.EngineName + " session"}
	}
	for _, line := range packSeparatedPieces(meta, c.inner, richSeparator(caps)) {
		for _, wrapped := range WrapText(line, c.inner) {
			c.line(caps.Palette.Dim + wrapped + reset)
		}
	}

	c.divider("system")
	versions := []string{
		versionPiece(caps, in.EngineName, in.EngineVersion, in.EngineTarget, in.EngineTone),
		versionPiece(caps, "wrapper", in.WrapperVersion, in.WrapperTarget, in.WrapperTone),
	}
	health := make([]string, 0, len(in.Dots))
	for _, dot := range in.Dots {
		if dot.Name != "" {
			health = append(health, buildDot(caps, dot))
		}
	}
	// On wide terminals align versions and health in two visual columns.
	// At narrower widths every item remains visible in a stacked layout.
	column := (c.inner - 4) / 2
	fitColumns := c.inner >= 72
	for _, piece := range versions {
		if VisibleWidth(piece) > column {
			fitColumns = false
		}
	}
	if fitColumns {
		right := packPieces(health, c.inner-column-4, 3)
		rows := len(versions)
		if len(right) > rows {
			rows = len(right)
		}
		for i := 0; i < rows; i++ {
			left, value := "", ""
			if i < len(versions) {
				left = versions[i]
			}
			if i < len(right) {
				value = right[i]
			}
			c.line(PadRight(left, column) + "    " + value)
		}
	} else {
		for _, line := range packPieces(versions, c.inner, 4) {
			c.line(line)
		}
		for _, line := range packPieces(health, c.inner, 3) {
			c.line(line)
		}
	}
	if in.Concurrent {
		renderPlainText(c, strOr(in.ConcurrentNote, "Managed content sync paused; auth freshness remains active."))
	}

	if len(in.QuotaRows) > 0 || in.QuotaNote != "" || in.QuotaWarn != "" || in.QuotaBlock != "" {
		c.divider("quota")
		for _, row := range in.QuotaRows {
			for _, line := range formatQuotaLines(caps, row, c.inner) {
				c.line(line)
			}
		}
		if in.QuotaNote != "" {
			renderToneText(c, ToneDim, in.QuotaNote)
		}
		if in.QuotaWarn != "" {
			renderToneText(c, ToneWarn, in.QuotaWarn)
		}
		if in.QuotaBlock != "" {
			renderToneText(c, ToneFail, in.QuotaBlock)
		}
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
	if comm := CleanInline(in.Launch.Communicator); comm != "" {
		if len(in.SessionRows) == 0 {
			c.divider("activity")
		}
		for _, line := range WrapText("communicator "+comm, c.inner) {
			c.line(caps.Palette.Dim + line + reset)
		}
	}

	if in.BypassPermissions {
		c.divider("security")
		renderToneText(c, ToneWarn, "Bypass permissions active for this run.")
	}

	showResult := !concurrentResultAlreadyShown(in)
	if showResult || len(in.Launch.Problems) > 0 {
		c.divider("")
	}
	for _, problem := range in.Launch.Problems {
		renderToneTextLimited(c, ToneWarn, problem, 2)
	}
	if showResult && (strings.TrimSpace(in.ResultLabel) != "" || len(in.Launch.Problems) == 0) {
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

func policyNote(in ScreenInput) string {
	from := CleanInline(in.Launch.PolicyFrom)
	if from == "" || from == CleanInline(in.Model) {
		return ""
	}
	return "(policy: " + from + " → " + CleanInline(in.Model) + ")"
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
	if account := CleanInline(in.Launch.Account); account != "" {
		parts = append(parts, account)
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

// PrintMinimalScreen is deterministic, ANSI-free, and suitable for pipes,
// cron logs, dumb terminals, and the explicit --minimal mode.
func PrintMinimalScreen(w io.Writer, in ScreenInput) {
	printMinimalScreen(w, in, DetectCapsFor(w, in.Theme))
}

func printMinimalScreen(w io.Writer, in ScreenInput, caps Caps) {
	in = applyLaunch(normalizeScreen(in))
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
		in.EngineName+"="+minimalVersion(in.EngineVersion, in.EngineTarget),
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
		if from := PlainInline(in.Launch.PolicyFrom); from != "" && from != PlainInline(in.Model) {
			fields = append(fields, "policy_from="+from)
		}
	} else if in.Effort != "" {
		fields = append(fields, "effort="+PlainInline(in.Effort))
	}
	if account := PlainInline(in.Launch.Account); account != "" {
		fields = append(fields, "account="+account)
	}
	if session := PlainInline(in.Launch.Session); session != "" {
		fields = append(fields, "session="+session)
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
	printPlainLine(w, caps, in.Prefix+" | "+strings.Join(fields, " | "))

	if len(in.Dots) > 0 {
		health := make([]string, 0, len(in.Dots))
		for _, dot := range in.Dots {
			if dot.Name != "" {
				health = append(health, PlainInline(dot.Name)+"="+healthWord(dot))
			}
		}
		printPlainLine(w, caps, "health | "+strings.Join(health, " | "))
	}
	for _, row := range in.QuotaRows {
		reset := ""
		if row.ResetAfter > 0 {
			reset = " | reset=" + ResetInText(row.ResetAfter)
		} else if row.ResetUnknown {
			reset = " | reset=unknown"
		}
		forecast := ""
		if row.Projection != "" {
			forecast = " | forecast=" + PlainInline(row.Projection)
		}
		printPlainLine(w, caps, fmt.Sprintf("quota | %s=%d%%%s%s%s", PlainInline(row.Label), clampPct(row.Used), reset, forecast, quotaFreshness(row)))
	}
	if in.QuotaNote != "" {
		printPlainLine(w, caps, "quota | "+PlainInline(in.QuotaNote))
	}
	if len(in.SessionRows) > 0 {
		parts := make([]string, 0, len(in.SessionRows))
		for _, row := range in.SessionRows {
			parts = append(parts, PlainInline(row.Label)+"="+GroupedInt(row.Count))
		}
		printPlainLine(w, caps, "activity | "+strings.Join(parts, " | "))
	}
	if comm := PlainInline(in.Launch.Communicator); comm != "" {
		printPlainLine(w, caps, "communicator | "+comm)
	}
	for _, problem := range in.Launch.Problems {
		printPlainLineLimited(w, caps, "warning | "+PlainInline(problem), 2)
	}
	if in.BypassPermissions {
		printPlainLine(w, caps, "warning | bypass permissions active (--dangerously-skip-permissions)")
	}
	if in.ConcurrentNote != "" && in.Concurrent {
		printPlainLine(w, caps, "notice | "+PlainInline(in.ConcurrentNote))
	}
	if in.QuotaWarn != "" {
		printPlainLine(w, caps, "warning | "+PlainInline(in.QuotaWarn))
	}
	if in.QuotaBlock != "" {
		printPlainLine(w, caps, "blocked | "+PlainInline(in.QuotaBlock))
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

func quotaFreshness(row QuotaRow) string {
	if row.Stale {
		return " | stale=true"
	}
	return ""
}

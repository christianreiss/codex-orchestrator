package terminalui

import (
	"fmt"
	"io"
	"strings"
)

// Notice topics. Every one-line wrapper message names one of these so the
// same subject reads the same way on both engines and in logs.
const (
	TopicAuth      = "auth"
	TopicConfig    = "config"
	TopicCron      = "cron"
	TopicLane      = "lane"
	TopicLogin     = "login"
	TopicProfile   = "profile"
	TopicQuota     = "quota"
	TopicSession   = "session"
	TopicStatus    = "status"
	TopicSync      = "sync"
	TopicUninstall = "uninstall"
	TopicUpdate    = "update"
	TopicUpload    = "auth-upload"
	TopicUsage     = "usage"
)

// Notice is the single grammar for wrapper messages outside the framed
// screens. Rich terminals get a tone glyph, the engine badge in its accent
// colour, a muted topic and the message, with detail lines hanging under the
// message column:
//
//	✓ cdx sync    Codex updated 0.144.0 → 0.144.1
//	▲ clx quota   Recommend OpenAI (cdx)
//	              5h window: 97% used; resets in 1h12m
//
// Plain destinations (pipes, logs, TERM=dumb, --minimal) keep the historical
// greppable form "cdx sync: message", with details indented two spaces.
type Notice struct {
	Prefix  string
	Topic   string
	Tone    Tone
	Message string
	Details []string
	Table   [][]string
}

// Say detects capabilities for w and prints one notice.
func Say(w io.Writer, prefix string, tone Tone, topic, message string, details ...string) {
	PrintNotice(w, DetectCapsFor(w, ""), Notice{Prefix: prefix, Topic: topic, Tone: tone, Message: message, Details: details})
}

// Sayf is Say with a formatted message.
func Sayf(w io.Writer, prefix string, tone Tone, topic, format string, args ...any) {
	Say(w, prefix, tone, topic, fmt.Sprintf(format, args...))
}

// PrintNotice renders n with explicit capabilities in a single write.
func PrintNotice(w io.Writer, caps Caps, n Notice) {
	_, _ = io.WriteString(w, FormatNotice(caps, n))
}

// FormatNotice returns the rendered notice including its trailing newline.
func FormatNotice(caps Caps, n Notice) string {
	prefix := CleanInline(n.Prefix)
	if prefix == "" {
		prefix = "cxx"
	}
	caps = engineCaps(caps, prefix)
	if noticePlain(caps) {
		return formatPlainNotice(caps, prefix, n) + formatNoticeTable(caps, n.Table)
	}
	return formatRichNotice(caps, prefix, n) + formatNoticeTable(caps, n.Table)
}

// Table cells are sanitized before alignment. Unlike prose details, table
// padding must survive whitespace normalization; narrow terminals use records.
func formatNoticeTable(caps Caps, rows [][]string) string {
	if len(rows) == 0 || len(rows[0]) == 0 {
		return ""
	}
	widths := make([]int, len(rows[0]))
	clean := make([][]string, len(rows))
	for i, row := range rows {
		if len(row) != len(widths) {
			return ""
		}
		clean[i] = make([]string, len(row))
		for j, cell := range row {
			clean[i][j] = PlainInline(cell)
			if w := VisibleWidth(clean[i][j]); w > widths[j] {
				widths[j] = w
			}
		}
	}
	width := 3*(len(widths)-1) + 2
	for _, w := range widths {
		width += w
	}
	var b strings.Builder
	if caps.IsTTY && caps.Columns > 0 && width > caps.Columns {
		for _, row := range clean[1:] {
			parts := []string{row[0] + ":"}
			for j, cell := range row[1:] {
				parts = append(parts, strings.ToLower(clean[0][j+1])+"="+cell)
			}
			for _, line := range WrapText(strings.Join(parts, " "), caps.Columns-2) {
				b.WriteString("  " + line + "\n")
			}
		}
		return b.String()
	}
	if !noticePlain(caps) {
		return formatRichNoticeTable(caps, clean, widths)
	}
	for i, row := range clean {
		parts := make([]string, len(row))
		for j, cell := range row {
			parts[j] = PadRight(cell, widths[j])
		}
		b.WriteString("  " + strings.TrimRight(strings.Join(parts, " | "), " ") + "\n")
		if i == 0 {
			for j, w := range widths {
				parts[j] = strings.Repeat("-", w)
			}
			b.WriteString("  " + strings.Join(parts, "-+-") + "\n")
		}
	}
	return b.String()
}

// formatRichNoticeTable draws the table for colour terminals: dim header and
// separators, the engine name in its accent colour, numbers right-aligned and
// zero/unavailable cells dimmed so the live counts stand out. Plain output
// keeps the greppable "a | b" form above.
func formatRichNoticeTable(caps Caps, rows [][]string, widths []int) string {
	p := caps.Palette
	vbar, cross := caps.BannerSym.BoxV, "+"
	if vbar == "│" {
		cross = "┼"
	}
	sep := p.Dim + " " + vbar + " " + p.Reset
	var b strings.Builder
	for i, row := range rows {
		cells := make([]string, len(row))
		for j, cell := range row {
			pad := PadRight(cell, widths[j])
			switch {
			case i == 0:
				cells[j] = p.Dim + pad + p.Reset
			case j == 0:
				cells[j] = engineCaps(caps, row[0]).BannerColor() + pad + p.Reset
			default:
				pad = strings.Repeat(" ", widths[j]-VisibleWidth(cell)) + cell
				if cell == "0" || cell == "?" || cell == "-" {
					pad = p.Dim + pad + p.Reset
				}
				cells[j] = pad
			}
		}
		b.WriteString("  " + strings.Join(cells, sep) + "\n")
		if i == 0 {
			rule := make([]string, len(widths))
			for j, w := range widths {
				n := w + 2
				if j == 0 || j == len(widths)-1 {
					n = w + 1
				}
				rule[j] = strings.Repeat(caps.BannerSym.BoxH, n)
			}
			b.WriteString("  " + p.Dim + strings.Join(rule, cross) + p.Reset + "\n")
		}
	}
	return b.String()
}

func noticePlain(caps Caps) bool {
	return !caps.IsTTY || caps.Dumb || caps.Columns < minRichColumns
}

func formatPlainNotice(caps Caps, prefix string, n Notice) string {
	// Pipes, logs and --minimal keep one physical line per record so paths
	// and tokens survive grep and copy/paste. Only a real (dumb or narrow)
	// terminal display wraps.
	width := 1 << 20
	if caps.IsTTY {
		width = caps.Columns
		if width <= 0 {
			width = 80
		}
	}
	var b strings.Builder
	head := PlainInline(prefix)
	if topic := PlainInline(n.Topic); topic != "" {
		head += " " + topic
	}
	for _, line := range hangWrap(head+": "+PlainInline(n.Message), width, 2) {
		b.WriteString(line + "\n")
	}
	for _, d := range n.Details {
		if d = PlainInline(d); d != "" {
			for _, line := range hangWrap(d, width-2, 0) {
				b.WriteString("  " + line + "\n")
			}
		}
	}
	return b.String()
}

// hangWrap wraps text to width; continuation lines are indented by indent
// spaces and still fit within width.
func hangWrap(text string, width, indent int) []string {
	if width < indent+8 {
		indent = 0
	}
	if width < 1 {
		width = 1
	}
	first := WrapText(text, width)
	if len(first) <= 1 || indent == 0 {
		return first
	}
	// Continue from the exact remainder so a hard-split word is not given a
	// space where it was broken.
	clean := CleanInline(text)
	rest := strings.TrimLeft(strings.TrimPrefix(clean, first[0]), " ")
	pad := strings.Repeat(" ", indent)
	out := []string{first[0]}
	for _, line := range WrapText(rest, width-indent) {
		out = append(out, pad+line)
	}
	return out
}

// noticeTopicWidth aligns messages into one column for the common short
// topics; longer topics simply push their own message right.
const noticeTopicWidth = 7

func formatRichNotice(caps Caps, prefix string, n Notice) string {
	p := caps.Palette
	tone := n.Tone
	if tone == "" {
		tone = ToneDim
	}
	glyph := noticeGlyph(caps, tone)
	topic := inlineFor(caps, n.Topic)
	lead := glyph + " " + prefix + " " + PadRight(topic, noticeTopicWidth) + " "
	indent := VisibleWidth(lead)
	width := caps.Columns
	if width <= 0 {
		width = 80
	}
	if width > maxCardWidth+indent {
		width = maxCardWidth + indent
	}
	body := width - indent
	if body < 16 {
		// Too narrow to hang text: put the message under the badge.
		body, indent = width-2, 2
	}

	styledLead := tonePalette(caps, tone) + glyph + p.Reset + " " +
		caps.BannerColor() + prefix + p.Reset + " " +
		p.Dim + PadRight(topic, noticeTopicWidth) + p.Reset + " "
	pad := strings.Repeat(" ", indent)

	var b strings.Builder
	msgStyle := ""
	if tone == ToneFail || tone == ToneWarn {
		msgStyle = p.Bold
	}
	lines := WrapText(inlineFor(caps, n.Message), body)
	if indent == 2 {
		b.WriteString(strings.TrimRight(styledLead, " ") + "\n")
		for _, line := range lines {
			b.WriteString(pad + msgStyle + line + p.Reset + "\n")
		}
	} else {
		for i, line := range lines {
			if i == 0 {
				b.WriteString(styledLead)
			} else {
				b.WriteString(pad)
			}
			b.WriteString(msgStyle + line + p.Reset + "\n")
		}
	}
	for _, d := range n.Details {
		if strings.TrimSpace(CleanInline(d)) == "" {
			continue
		}
		for _, line := range WrapText(inlineFor(caps, d), body) {
			b.WriteString(pad + p.Dim + line + p.Reset + "\n")
		}
	}
	return b.String()
}

// noticeIndent is the column where a rich notice hangs its detail lines.
func noticeIndent(caps Caps, prefix, topic string) int {
	if prefix = CleanInline(prefix); prefix == "" {
		prefix = "cxx"
	}
	indent := VisibleWidth(noticeGlyph(caps, ToneDim) + " " + prefix + " " + PadRight(inlineFor(caps, topic), noticeTopicWidth) + " ")
	width := caps.Columns
	if width <= 0 {
		width = 80
	}
	if width > maxCardWidth+indent {
		width = maxCardWidth + indent
	}
	if width-indent < 16 {
		return 2
	}
	return indent
}

// PromptBodyWidth is the width available to Question.Body lines in both the
// rich menu and the line-mode notice.
func PromptBodyWidth(caps Caps, prefix, topic string) int {
	width := caps.Columns
	if width <= 0 {
		width = 80
	}
	line := min(width, maxCardWidth+noticeIndent(caps, prefix, topic)) - noticeIndent(caps, prefix, topic)
	rich := min(width-2, maxCardWidth) - 4
	return max(min(line, rich), 16)
}

func noticeGlyph(caps Caps, tone Tone) string {
	if !caps.UTF8 {
		switch tone {
		case ToneOK:
			return "+"
		case ToneWarn:
			return "!"
		case ToneFail:
			return "x"
		default:
			return ">"
		}
	}
	switch tone {
	case ToneOK:
		return "✓"
	case ToneWarn:
		return "▲"
	case ToneFail:
		return "✗"
	default:
		return "›"
	}
}

// inlineFor sanitizes dynamic text for the destination: Unicode survives on
// UTF-8 terminals, everything else is folded to its ASCII spelling.
func inlineFor(caps Caps, s string) string {
	if caps.UTF8 && !caps.Dumb {
		return CleanInline(s)
	}
	return PlainInline(s)
}

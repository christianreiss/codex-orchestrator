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
		return formatPlainNotice(caps, prefix, n)
	}
	return formatRichNotice(caps, prefix, n)
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

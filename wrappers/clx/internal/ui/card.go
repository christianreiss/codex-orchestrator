package ui

import (
	"fmt"
	"io"
	"strings"
	"unicode"
)

const maxCardWidth = 92

// card is the small responsive frame shared by the boot screen and doctor.
// Its helpers are ANSI-width aware and never print beyond the detected width.
type card struct {
	w     io.Writer
	caps  Caps
	width int
	inner int
}

func newCard(w io.Writer, caps Caps) card {
	width := caps.Columns - 2
	if width > maxCardWidth {
		width = maxCardWidth
	}
	if width < 4 {
		width = 4
	}
	return card{w: w, caps: caps, width: width, inner: width - 4}
}

func (c card) top()    { c.edge(c.caps.BannerSym.BoxTL, c.caps.BannerSym.BoxTR) }
func (c card) bottom() { c.edge(c.caps.BannerSym.BoxBL, c.caps.BannerSym.BoxBR) }

func (c card) edge(left, right string) {
	p := c.caps.Palette.Dim
	r := c.caps.Palette.Reset
	fmt.Fprintln(c.w, p+left+strings.Repeat(c.caps.BannerSym.BoxH, c.width-2)+right+r)
}

func (c card) divider(label string) {
	p := c.caps.Palette.Dim
	r := c.caps.Palette.Reset
	h := c.caps.BannerSym.BoxH
	left, right := "├", "┤"
	if c.caps.Dumb || !c.caps.UTF8 {
		left, right = "+", "+"
	}
	if strings.TrimSpace(label) == "" {
		fmt.Fprintln(c.w, p+left+strings.Repeat(h, c.width-2)+right+r)
		return
	}
	label = strings.ToUpper(CleanInline(label))
	label = TruncateText(label, c.width-6, c.caps)
	used := 3 + VisibleWidth(label) // "- " + label + " "
	rest := c.width - 2 - used
	if rest < 0 {
		rest = 0
	}
	fmt.Fprintln(c.w,
		p+left+h+" "+r+
			c.caps.Palette.Bold+label+r+
			p+" "+strings.Repeat(h, rest)+right+r,
	)
}

func (c card) line(content string) {
	content = fitStyled(content, c.inner, c.caps)
	p := c.caps.Palette.Dim
	r := c.caps.Palette.Reset
	fmt.Fprintln(c.w, p+c.caps.BannerSym.BoxV+r+" "+content+" "+p+c.caps.BannerSym.BoxV+r)
}

func fitStyled(s string, width int, caps Caps) string {
	if width <= 0 {
		return ""
	}
	if VisibleWidth(s) > width {
		s = TruncateText(CleanInline(s), width, caps)
	}
	return s + strings.Repeat(" ", width-VisibleWidth(s))
}

func joinSides(left, right string, width int, caps Caps) string {
	if width <= 0 {
		return ""
	}
	rightWidth := VisibleWidth(right)
	if rightWidth >= width {
		return TruncateText(CleanInline(right), width, caps)
	}
	leftWidth := width - rightWidth - 1
	if VisibleWidth(left) > leftWidth {
		left = TruncateText(CleanInline(left), leftWidth, caps)
	}
	return left + strings.Repeat(" ", width-VisibleWidth(left)-rightWidth) + right
}

func packPieces(pieces []string, width, gap int) []string {
	if width <= 0 {
		return nil
	}
	separator := strings.Repeat(" ", gap)
	lines := []string{}
	line := ""
	for _, piece := range pieces {
		if strings.TrimSpace(CleanInline(piece)) == "" {
			continue
		}
		candidate := piece
		if line != "" {
			candidate = line + separator + piece
		}
		if line != "" && VisibleWidth(candidate) > width {
			lines = append(lines, line)
			line = piece
			continue
		}
		line = candidate
	}
	if line != "" {
		lines = append(lines, line)
	}
	return lines
}

func packSeparatedPieces(pieces []string, width int, separator string) []string {
	if width <= 0 {
		return nil
	}
	lines := []string{}
	line := ""
	for _, piece := range pieces {
		piece = CleanInline(piece)
		if piece == "" {
			continue
		}
		candidate := piece
		if line != "" {
			candidate = line + separator + piece
		}
		if line != "" && VisibleWidth(candidate) > width {
			lines = append(lines, line)
			line = piece
			continue
		}
		line = candidate
	}
	if line != "" {
		lines = append(lines, line)
	}
	return lines
}

// CleanInline removes terminal escapes and control characters from dynamic
// values before they are placed in a fixed-height layout.
func CleanInline(s string) string {
	s = StripANSI(s)
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

// PlainInline is the portable log form used by compact/non-interactive output.
func PlainInline(s string) string {
	s = CleanInline(s)
	return strings.NewReplacer(
		"⚡", "spark", "→", "->", "←", "<-", "—", "-", "–", "-", "…", "...",
	).Replace(s)
}

// TruncateText clamps plain text to width visible cells and appends an
// ellipsis when possible.
func TruncateText(s string, width int, caps Caps) string {
	s = CleanInline(s)
	if width <= 0 {
		return ""
	}
	if VisibleWidth(s) <= width {
		return s
	}
	ellipsis := "…"
	if caps.Dumb || !caps.UTF8 {
		ellipsis = "..."
	}
	if width <= VisibleWidth(ellipsis) {
		ellipsis = strings.Repeat(".", width)
		return ellipsis
	}
	limit := width - VisibleWidth(ellipsis)
	var b strings.Builder
	used := 0
	runes := []rune(s)
	for i := 0; i < len(runes); {
		next, cells := nextCluster(runes, i)
		if used+cells > limit {
			break
		}
		b.WriteString(string(runes[i:next]))
		used += cells
		i = next
	}
	return strings.TrimRight(b.String(), " ") + ellipsis
}

// WrapText wraps sanitized text without ever exceeding width visible cells.
func WrapText(s string, width int) []string {
	s = CleanInline(s)
	if width <= 0 || s == "" {
		return []string{""}
	}
	words := strings.Fields(s)
	lines := []string{}
	line := ""
	for _, word := range words {
		for VisibleWidth(word) > width {
			if line != "" {
				lines = append(lines, line)
				line = ""
			}
			prefix, rest := splitVisible(word, width)
			lines = append(lines, prefix)
			word = rest
		}
		if word == "" {
			continue
		}
		candidate := word
		if line != "" {
			candidate = line + " " + word
		}
		if VisibleWidth(candidate) > width {
			lines = append(lines, line)
			line = word
		} else {
			line = candidate
		}
	}
	if line != "" {
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}

func splitVisible(s string, width int) (string, string) {
	if width <= 0 {
		return "", s
	}
	runes := []rune(s)
	used, idx := 0, 0
	for idx < len(runes) {
		next, cells := nextCluster(runes, idx)
		if used+cells > width {
			break
		}
		used += cells
		idx = next
	}
	if idx == 0 && len(runes) > 0 {
		idx = 1
	}
	return string(runes[:idx]), string(runes[idx:])
}

func toneSymbol(caps Caps, tone Tone, updated bool) string {
	if caps.Dumb || !caps.UTF8 {
		if updated {
			return "^"
		}
		switch tone {
		case ToneWarn:
			return "!"
		case ToneFail:
			return "X"
		case ToneDim:
			return "-"
		default:
			return "OK"
		}
	}
	if updated {
		return "↑"
	}
	switch tone {
	case ToneWarn:
		return "!"
	case ToneFail:
		return "×"
	case ToneDim:
		return "·"
	default:
		return "✓"
	}
}

func toneWord(tone Tone) string {
	switch tone {
	case ToneWarn:
		return "attention"
	case ToneFail:
		return "blocked"
	case ToneDim:
		return "unknown"
	default:
		return "ready"
	}
}

func styleTone(caps Caps, tone Tone, text string) string {
	return tonePalette(caps, tone) + text + caps.Palette.Reset
}

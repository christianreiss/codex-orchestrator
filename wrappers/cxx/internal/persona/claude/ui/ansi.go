// Package ui renders the cdx neofetch-style boot screen, doctor table, status
// summary, quota bars, and exit footer. It owns all ANSI/colour logic so the
// rest of the binary stays plain.
//
// Output goes to stderr — stdout is reserved for upstream Codex passthrough.
package ui

import (
	"io"
	"os"
	"strings"
	"unicode"

	"golang.org/x/term"
)

// Theme governs the banner colour. The hint comes from the baked config.
type Theme int

const (
	ThemeAuto Theme = iota
	ThemeOrange
	ThemePink
	ThemeViolet // used by clx via duplicate package
)

// Palette is the resolved ANSI colour table. All fields are valid escape
// strings (or empty when colour is disabled).
type Palette struct {
	Bold      string
	Dim       string
	Reset     string
	Green     string
	Yellow    string
	Orange    string
	Pink      string
	Violet    string
	Cyan      string
	Blue      string
	Magenta   string
	Red       string
	ClearLine string
}

// Caps describes terminal capabilities relevant to rendering.
type Caps struct {
	IsTTY     bool
	NoColor   bool
	Dumb      bool
	UTF8      bool
	Columns   int
	Theme     Theme
	Palette   Palette
	BannerSym BannerGlyphs
}

// BannerGlyphs swaps the box/bar glyphs to ASCII on dumb terminals.
type BannerGlyphs struct {
	Fill      string // █
	Empty     string // ░
	BoxTL     string // ╭
	BoxTR     string // ╮
	BoxBL     string // ╰
	BoxBR     string // ╯
	BoxH      string // ─
	BoxV      string // │
	BarFill   string // █
	BarEmpty  string // ░
	DotOK     string // ●
	DotWarn   string // ●
	DotFail   string // ●
	DotUp     string // ⬆ (this run synced)
	IconOK    string // ✅
	IconWarn  string // ⚠
	IconFail  string // ⛔
	IconSpark string // ⚡
}

// DetectCaps inspects stderr + env to resolve the colour palette and glyphs.
// adminTheme is the hint baked into config (auto, auto-pink, light, dark,
// bright-pink, dark-pink — anything else falls back to auto).
func DetectCaps(adminTheme string) Caps {
	return detectCaps(int(os.Stderr.Fd()), adminTheme)
}

// DetectCapsFor resolves capabilities for the stream that will actually be
// rendered. This keeps `status >file` and tests from inheriting stderr's TTY
// state while preserving DetectCaps for stderr-only progress paths.
func DetectCapsFor(w io.Writer, adminTheme string) Caps {
	if f, ok := w.(*os.File); ok {
		return detectCaps(int(f.Fd()), adminTheme)
	}
	// A generic writer has no terminal descriptor. Treat it as redirected
	// output instead of accidentally inheriting stderr's TTY state.
	return detectCaps(-1, adminTheme)
}

// MinimalCaps forces the deterministic, portable rendering path even when the
// destination is an otherwise capable TTY. Explicit --minimal must be stronger
// than terminal auto-detection: no colour, Unicode glyphs, or framed cards.
func MinimalCaps(caps Caps) Caps {
	caps.IsTTY = false
	caps.NoColor = true
	caps.Dumb = true
	caps.UTF8 = false
	caps.Palette = Palette{}
	return caps
}

func detectCaps(fd int, adminTheme string) Caps {
	noColor := os.Getenv("NO_COLOR") != ""
	termEnv := strings.ToLower(os.Getenv("TERM"))
	dumb := termEnv == "dumb" || termEnv == ""
	isTTY := term.IsTerminal(fd)
	utf8 := looksUTF8()
	cols := 80
	measuredWidth := false
	if isTTY {
		if w, _, err := term.GetSize(fd); err == nil && w > 0 {
			cols = w
			measuredWidth = true
		}
	}
	if v := os.Getenv("COLUMNS"); v != "" && !measuredWidth {
		// COLUMNS is a fallback for redirected/test writers. A measured PTY
		// width always wins because shell metadata can be stale after resize.
		if n := atoiSafe(v); n > 0 {
			cols = n
		}
	}

	pal := Palette{}
	if isTTY && !noColor && !dumb {
		pal = Palette{
			Bold:      "\033[1m",
			Dim:       "\033[2m",
			Reset:     "\033[0m",
			Green:     "\033[32m",
			Yellow:    "\033[33m",
			Orange:    "\033[38;5;208m",
			Pink:      "\033[38;5;205m",
			Violet:    "\033[38;5;141m",
			Cyan:      "\033[96m",
			Blue:      "\033[36m",
			Magenta:   "\033[35m",
			Red:       "\033[31m",
			ClearLine: "\033[K",
		}
	}

	theme := resolveTheme(adminTheme)

	g := BannerGlyphs{
		Fill: "█", Empty: "░",
		BoxTL: "╭", BoxTR: "╮", BoxBL: "╰", BoxBR: "╯", BoxH: "─", BoxV: "│",
		BarFill: "█", BarEmpty: "░",
		DotOK: "●", DotWarn: "●", DotFail: "●",
		DotUp:  "⬆",
		IconOK: "✅", IconWarn: "⚠", IconFail: "⛔", IconSpark: "⚡",
	}
	if dumb || !utf8 {
		g = BannerGlyphs{
			Fill: "#", Empty: "-",
			BoxTL: "+", BoxTR: "+", BoxBL: "+", BoxBR: "+", BoxH: "-", BoxV: "|",
			BarFill: "#", BarEmpty: "-",
			DotOK: "*", DotWarn: "*", DotFail: "*",
			DotUp:  "^",
			IconOK: "OK", IconWarn: "WARN", IconFail: "FAIL", IconSpark: "S",
		}
	}

	return Caps{
		IsTTY: isTTY, NoColor: noColor, Dumb: dumb, UTF8: utf8,
		Columns: cols, Theme: theme, Palette: pal, BannerSym: g,
	}
}

func resolveTheme(hint string) Theme {
	switch strings.ToLower(strings.TrimSpace(hint)) {
	case "auto-pink", "bright-pink", "dark-pink":
		return ThemePink
	default:
		return ThemeOrange
	}
}

func looksUTF8() bool {
	for _, k := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
		v := strings.ToLower(os.Getenv(k))
		if v != "" {
			return strings.Contains(v, "utf-8") || strings.Contains(v, "utf8")
		}
	}
	return false
}

// maxAtoiSafe bounds the values atoiSafe will return; callers use this for
// terminal widths, so anything beyond a generous sanity limit is rejected
// rather than risking overflow or a huge strings.Repeat allocation downstream.
const maxAtoiSafe = 1000

func atoiSafe(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
		if n > maxAtoiSafe {
			return 0
		}
	}
	return n
}

// StripANSI removes terminal escape sequences, including CSI colour/cursor
// controls and OSC title/hyperlink payloads. Dynamic server values pass
// through this before rendering, so an untrusted label cannot repaint the
// terminal or forge another row.
func StripANSI(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] != 0x1b {
			b.WriteByte(s[i])
			i++
			continue
		}
		i++
		if i >= len(s) {
			break
		}
		switch s[i] {
		case '[': // CSI: parameters/intermediates followed by a final byte.
			i++
			for i < len(s) && (s[i] < 0x40 || s[i] > 0x7e) {
				i++
			}
			if i < len(s) {
				i++
			}
		case ']', 'P', 'X', '^', '_': // OSC/DCS/SOS/PM/APC until BEL or ST.
			i++
			for i < len(s) {
				if s[i] == 0x07 {
					i++
					break
				}
				if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '\\' {
					i += 2
					break
				}
				i++
			}
		default:
			// Two-byte escape or a character-set sequence with intermediate
			// bytes. Consume the complete sequence, never its payload text.
			for i < len(s) && s[i] >= 0x20 && s[i] <= 0x2f {
				i++
			}
			if i < len(s) {
				i++
			}
		}
	}
	return b.String()
}

// VisibleWidth approximates the printed column width of s, treating the
// engine spark glyph and emoji-like wide glyphs as width 2 and ANSI as 0.
func VisibleWidth(s string) int {
	runes := []rune(StripANSI(s))
	width := 0
	for i := 0; i < len(runes); {
		next, cells := nextCluster(runes, i)
		width += cells
		i = next
	}
	return width
}

func isWide(r rune) bool {
	if r >= 0x1100 && r <= 0x115F {
		return true
	}
	if r >= 0x2E80 && r <= 0x9FFF {
		return true
	}
	if r >= 0xAC00 && r <= 0xD7A3 {
		return true
	}
	if r >= 0xF900 && r <= 0xFAFF {
		return true
	}
	if r >= 0xFE30 && r <= 0xFE4F {
		return true
	}
	if r >= 0xFF00 && r <= 0xFF60 {
		return true
	}
	if r >= 0x1F300 && r <= 0x1FAFF {
		return true
	}
	return false
}

// nextCluster returns the next printable cluster boundary and its terminal
// cell width. It covers combining marks, variation selectors, emoji modifiers,
// regional-indicator flags, and ZWJ emoji sequences without pulling a large
// Unicode dependency into the static wrappers.
func nextCluster(runes []rune, start int) (int, int) {
	if start >= len(runes) {
		return start, 0
	}
	r := runes[start]
	if isZeroWidthRune(r) || unicode.IsControl(r) {
		return start + 1, 0
	}
	width := baseRuneWidth(r)
	i := start + 1
	if isRegionalIndicator(r) && i < len(runes) && isRegionalIndicator(runes[i]) {
		return i + 1, 2
	}
	for i < len(runes) {
		switch {
		case isVariationSelector(runes[i]):
			if runes[i] == 0xfe0f && width < 2 {
				width = 2
			}
			i++
		case isCombiningRune(runes[i]) || isEmojiModifier(runes[i]):
			i++
		case runes[i] == 0x200d && i+1 < len(runes):
			// A ZWJ joins the next base into this same displayed glyph.
			i += 2
			if width < 2 {
				width = 2
			}
		default:
			return i, width
		}
	}
	return i, width
}

func baseRuneWidth(r rune) int {
	if r == '⚡' || isWide(r) || isRegionalIndicator(r) {
		return 2
	}
	return 1
}

func isZeroWidthRune(r rune) bool {
	return r == 0 || r == 0x200d || isCombiningRune(r) || isVariationSelector(r) || isEmojiModifier(r)
}

func isCombiningRune(r rune) bool {
	return unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Mc, r) || unicode.Is(unicode.Me, r)
}

func isVariationSelector(r rune) bool {
	return (r >= 0xfe00 && r <= 0xfe0f) || (r >= 0xe0100 && r <= 0xe01ef)
}

func isEmojiModifier(r rune) bool { return r >= 0x1f3fb && r <= 0x1f3ff }

func isRegionalIndicator(r rune) bool { return r >= 0x1f1e6 && r <= 0x1f1ff }

// PadRight pads s with spaces on the right so its visible width reaches width.
func PadRight(s string, width int) string {
	w := VisibleWidth(s)
	if w >= width {
		return s
	}
	return s + strings.Repeat(" ", width-w)
}

// BannerColor keeps every clx surface on the same violet identity. It falls
// back to bold-only when colour is disabled.
func (c Caps) BannerColor() string {
	return c.Palette.Violet + c.Palette.Bold
}

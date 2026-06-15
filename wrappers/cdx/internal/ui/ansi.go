// Package ui renders the cdx neofetch-style boot screen, doctor table, status
// summary, quota bars, and exit footer. It owns all ANSI/colour logic so the
// rest of the binary stays plain.
//
// Output goes to stderr — stdout is reserved for upstream Codex passthrough.
package ui

import (
	"os"
	"regexp"
	"strings"

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
	noColor := os.Getenv("NO_COLOR") != ""
	termEnv := strings.ToLower(os.Getenv("TERM"))
	dumb := termEnv == "dumb" || termEnv == ""
	isTTY := term.IsTerminal(int(os.Stderr.Fd()))
	utf8 := looksUTF8()
	cols := 80
	if isTTY {
		if w, _, err := term.GetSize(int(os.Stderr.Fd())); err == nil && w > 0 {
			cols = w
		}
	}
	if v := os.Getenv("COLUMNS"); v != "" {
		// $COLUMNS overrides only when explicit.
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
		if strings.Contains(v, "utf-8") || strings.Contains(v, "utf8") {
			return true
		}
	}
	return false
}

func atoiSafe(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// ansiRE matches CSI/SGR sequences for visible-width math.
var ansiRE = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)

// StripANSI removes ANSI SGR sequences from s.
func StripANSI(s string) string { return ansiRE.ReplaceAllString(s, "") }

// VisibleWidth approximates the printed column width of s, treating the
// engine spark glyph and emoji-like wide glyphs as width 2 and ANSI as 0.
func VisibleWidth(s string) int {
	stripped := StripANSI(s)
	w := 0
	for _, r := range stripped {
		switch {
		case r == 0:
			// nothing
		case r < 0x20:
			// control char — count as 0
		case isWide(r):
			w += 2
		default:
			w++
		}
	}
	return w
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
	if r >= 0x2600 && r <= 0x27BF {
		return true
	}
	return false
}

// PadRight pads s with spaces on the right so its visible width reaches width.
func PadRight(s string, width int) string {
	w := VisibleWidth(s)
	if w >= width {
		return s
	}
	return s + strings.Repeat(" ", width-w)
}

// BannerColor picks the banner colour based on theme. Falls back to bold-only
// when colour is disabled.
func (c Caps) BannerColor() string {
	switch c.Theme {
	case ThemePink:
		return c.Palette.Pink + c.Palette.Bold
	case ThemeViolet:
		return c.Palette.Violet + c.Palette.Bold
	default:
		return c.Palette.Orange + c.Palette.Bold
	}
}

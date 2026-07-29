package ui

import (
	"bytes"
	"testing"
)

// StripANSI is the terminal-injection guard every dynamic server value passes
// through, so each escape family gets its own case: a regression that leaves a
// payload behind would otherwise only show up as a screen/doctor test still
// comparing text that was already stripped before it reached the assertion.
func TestStripANSIRemovesEveryEscapeFamily(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		want string
	}{
		{name: "csi colour", in: "\x1b[31mred\x1b[0m", want: "red"},
		{name: "csi cursor move", in: "\x1b[2K\x1b[1;5Hrow", want: "row"},
		{name: "osc hyperlink terminated by bel", in: "\x1b]8;;https://evil.invalid\x07label\x1b]8;;\x07", want: "label"},
		{name: "osc title terminated by st", in: "\x1b]0;forged title\x1b\\kept", want: "kept"},
		{name: "dcs payload", in: "\x1bPq;1|raw device control\x1b\\ok", want: "ok"},
		{name: "sos payload", in: "\x1bXhidden string\x1b\\ok", want: "ok"},
		{name: "pm payload", in: "\x1b^privacy message\x1b\\ok", want: "ok"},
		{name: "apc payload terminated by bel", in: "\x1b_application command\x07ok", want: "ok"},
		{name: "two-byte escape", in: "\x1b>keypad", want: "keypad"},
		{name: "charset escape with intermediate byte", in: "\x1b(Bplain", want: "plain"},
		{name: "lone trailing escape", in: "run\x1b", want: "run"},
		{name: "truncated csi", in: "run\x1b[38;5;", want: "run"},
		{name: "truncated osc", in: "label\x1b]8;;https://evil.invalid", want: "label"},
		{name: "no escapes", in: "plain ascii text", want: "plain ascii text"},
		{name: "no escapes with unicode", in: "café ✅", want: "café ✅"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := StripANSI(tc.in); got != tc.want {
				t.Errorf("StripANSI(%q) = %q want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestVisibleWidthAndPadRightIgnoreEscapes(t *testing.T) {
	for _, tc := range []struct {
		name      string
		in        string
		width     int
		wantWidth int
		wantPad   string
	}{
		{name: "already padded", in: "cdx   ", width: 6, wantWidth: 6, wantPad: "cdx   "},
		{name: "narrower than the string", in: "cdx   ", width: 4, wantWidth: 6, wantPad: "cdx   "},
		{name: "wide glyphs", in: "⚡日本", width: 8, wantWidth: 6, wantPad: "⚡日本  "},
		{name: "ansi wrapped", in: "\x1b[38;5;205mpink\x1b[0m", width: 6, wantWidth: 4, wantPad: "\x1b[38;5;205mpink\x1b[0m  "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := VisibleWidth(tc.in); got != tc.wantWidth {
				t.Errorf("VisibleWidth(%q) = %d want %d", tc.in, got, tc.wantWidth)
			}
			if got := PadRight(tc.in, tc.width); got != tc.wantPad {
				t.Errorf("PadRight(%q, %d) = %q want %q", tc.in, tc.width, got, tc.wantPad)
			}
		})
	}
}

// detectCaps runs against fd -1 here: tests never own a terminal descriptor, so
// this is the same path a redirected run takes and the colour gate resolves the
// way it does for `status >file`.
func TestDetectCapsResolvesColourAndGlyphsFromEnv(t *testing.T) {
	for _, tc := range []struct {
		name            string
		noColor         string
		termEnv         string
		lang            string
		wantNoColor     bool
		wantDumb        bool
		wantUTF8        bool
		wantASCIIGlyphs bool
	}{
		{name: "NO_COLOR set", noColor: "1", termEnv: "xterm-256color", lang: "en_US.UTF-8", wantNoColor: true, wantUTF8: true},
		{name: "TERM=dumb", termEnv: "dumb", lang: "en_US.UTF-8", wantDumb: true, wantUTF8: true, wantASCIIGlyphs: true},
		{name: "TERM empty", termEnv: "", lang: "en_US.UTF-8", wantDumb: true, wantUTF8: true, wantASCIIGlyphs: true},
		{name: "non-UTF-8 locale", termEnv: "xterm-256color", lang: "C", wantASCIIGlyphs: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("NO_COLOR", tc.noColor)
			t.Setenv("TERM", tc.termEnv)
			t.Setenv("LC_ALL", "")
			t.Setenv("LC_CTYPE", "")
			t.Setenv("LANG", tc.lang)
			t.Setenv("COLUMNS", "")

			caps := detectCaps(-1, "auto")
			if caps.IsTTY {
				t.Fatalf("fd -1 reported a TTY: %+v", caps)
			}
			if caps.NoColor != tc.wantNoColor || caps.Dumb != tc.wantDumb || caps.UTF8 != tc.wantUTF8 {
				t.Errorf("NoColor=%v Dumb=%v UTF8=%v want %v/%v/%v",
					caps.NoColor, caps.Dumb, caps.UTF8, tc.wantNoColor, tc.wantDumb, tc.wantUTF8)
			}
			if caps.Palette != (Palette{}) {
				t.Errorf("palette = %+v want empty", caps.Palette)
			}
			if caps.Columns != 80 {
				t.Errorf("Columns = %d want the 80 default", caps.Columns)
			}
			assertBannerGlyphs(t, caps.BannerSym, tc.wantASCIIGlyphs)
			wantBox, wantIcon := "╭", "✅"
			if tc.wantASCIIGlyphs {
				wantBox, wantIcon = "+", "OK"
			}
			if caps.BannerSym.BoxTL != wantBox || caps.BannerSym.IconOK != wantIcon {
				t.Errorf("BoxTL=%q IconOK=%q want %q/%q", caps.BannerSym.BoxTL, caps.BannerSym.IconOK, wantBox, wantIcon)
			}
		})
	}
}

// COLUMNS is the only width source without a measured PTY, and atoiSafe rejects
// anything that is not a plain decimal within the 1000-column bound.
func TestDetectCapsColumnsOverride(t *testing.T) {
	for _, tc := range []struct {
		name    string
		columns string
		want    int
	}{
		{name: "valid width", columns: "132", want: 132},
		{name: "upper bound accepted", columns: "1000", want: 1000},
		{name: "above bound rejected", columns: "1001", want: 80},
		{name: "non-numeric rejected", columns: "eighty", want: 80},
		{name: "negative sign rejected", columns: "-40", want: 80},
		{name: "zero rejected", columns: "0", want: 80},
		{name: "unset falls back", columns: "", want: 80},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("NO_COLOR", "")
			t.Setenv("TERM", "xterm-256color")
			t.Setenv("LC_ALL", "")
			t.Setenv("LC_CTYPE", "")
			t.Setenv("LANG", "en_US.UTF-8")
			t.Setenv("COLUMNS", tc.columns)

			if got := detectCaps(-1, "auto").Columns; got != tc.want {
				t.Errorf("COLUMNS=%q resolved to %d want %d", tc.columns, got, tc.want)
			}
		})
	}
}

func TestMinimalCapsForcesThePortablePath(t *testing.T) {
	rich := Caps{
		IsTTY: true, NoColor: false, Dumb: false, UTF8: true, Columns: 120, Theme: ThemePink,
		Palette:   Palette{Bold: "\x1b[1m", Reset: "\x1b[0m", Pink: "\x1b[38;5;205m"},
		BannerSym: BannerGlyphs{BoxTL: "╭", IconOK: "✅"},
	}

	got := MinimalCaps(rich)
	if got.IsTTY || got.UTF8 || !got.NoColor || !got.Dumb {
		t.Errorf("MinimalCaps kept capable rendering: %+v", got)
	}
	if got.Palette != (Palette{}) {
		t.Errorf("palette = %+v want empty", got.Palette)
	}
	if got.BannerColor() != "" {
		t.Errorf("BannerColor = %q want empty once colour is disabled", got.BannerColor())
	}
	if got.Columns != rich.Columns || got.Theme != rich.Theme || got.BannerSym != rich.BannerSym {
		t.Errorf("MinimalCaps changed width/theme/glyphs: %+v", got)
	}
}

func TestDetectCapsForBufferReportsRedirectedOutput(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	t.Setenv("TERM", "xterm-256color")
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_CTYPE", "")
	t.Setenv("LANG", "en_US.UTF-8")
	t.Setenv("COLUMNS", "120")

	var buf bytes.Buffer
	caps := DetectCapsFor(&buf, "auto")
	if caps.IsTTY {
		t.Fatalf("a bytes.Buffer inherited TTY state: %+v", caps)
	}
	if caps.Palette != (Palette{}) {
		t.Errorf("palette = %+v want empty", caps.Palette)
	}
	if caps.Columns != 120 {
		t.Errorf("Columns = %d want the COLUMNS fallback 120", caps.Columns)
	}
}

// resolveTheme maps only the three pink hints; every other string, including
// the light/dark ones the config can carry, lands on the default. No hint
// string reaches ThemeViolet, so that branch is only observable when Caps is
// built directly — which is what the clx screen tests do.
func TestResolveThemeAndBannerColor(t *testing.T) {
	pal := Palette{Bold: "\x1b[1m", Orange: "\x1b[38;5;208m", Pink: "\x1b[38;5;205m", Violet: "\x1b[38;5;141m"}

	// cdx maps the resolved theme onto a palette colour while clx pins every
	// surface to its violet identity, so this byte-identical file accepts the
	// theme's own colour or the wrapper's fixed one — both bold-suffixed.
	identity := Caps{Palette: pal}.BannerColor()
	if identity != pal.Orange+pal.Bold && identity != pal.Violet+pal.Bold {
		t.Fatalf("default banner colour = %q, want the orange or violet identity + bold", identity)
	}

	for _, tc := range []struct {
		name        string
		hint        string
		want        Theme
		themeColour string
	}{
		{name: "auto-pink", hint: "auto-pink", want: ThemePink, themeColour: pal.Pink},
		{name: "bright-pink", hint: "bright-pink", want: ThemePink, themeColour: pal.Pink},
		{name: "dark-pink", hint: "dark-pink", want: ThemePink, themeColour: pal.Pink},
		{name: "pink hint is trimmed and lowercased", hint: "  Bright-Pink  ", want: ThemePink, themeColour: pal.Pink},
		{name: "auto", hint: "auto", want: ThemeOrange, themeColour: pal.Orange},
		{name: "empty", hint: "", want: ThemeOrange, themeColour: pal.Orange},
		{name: "light", hint: "light", want: ThemeOrange, themeColour: pal.Orange},
		{name: "dark", hint: "dark", want: ThemeOrange, themeColour: pal.Orange},
		{name: "unknown", hint: "banana", want: ThemeOrange, themeColour: pal.Orange},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveTheme(tc.hint); got != tc.want {
				t.Fatalf("resolveTheme(%q) = %d want %d", tc.hint, got, tc.want)
			}
			got := Caps{Palette: pal, Theme: tc.want}.BannerColor()
			if want := tc.themeColour + pal.Bold; got != want && got != identity {
				t.Errorf("BannerColor = %q want %q or the wrapper identity %q", got, want, identity)
			}
		})
	}

	if got, want := (Caps{Palette: pal, Theme: ThemeViolet}).BannerColor(), pal.Violet+pal.Bold; got != want {
		t.Errorf("ThemeViolet BannerColor = %q want %q", got, want)
	}
	if got := (Caps{Theme: ThemePink}).BannerColor(); got != "" {
		t.Errorf("BannerColor with an empty palette = %q want empty", got)
	}
}

func assertBannerGlyphs(t *testing.T, g BannerGlyphs, wantASCII bool) {
	t.Helper()
	for _, glyph := range []string{
		g.Fill, g.Empty, g.BoxTL, g.BoxTR, g.BoxBL, g.BoxBR, g.BoxH, g.BoxV,
		g.BarFill, g.BarEmpty, g.DotOK, g.DotWarn, g.DotFail, g.DotUp,
		g.IconOK, g.IconWarn, g.IconFail, g.IconSpark,
	} {
		if glyph == "" {
			t.Fatalf("glyph set has an empty glyph: %+v", g)
		}
		ascii := true
		for _, r := range glyph {
			if r > 0x7f {
				ascii = false
			}
		}
		if ascii != wantASCII {
			t.Errorf("glyph %q is ascii=%v want %v", glyph, ascii, wantASCII)
		}
	}
}

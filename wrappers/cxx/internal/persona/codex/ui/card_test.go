package ui

import (
	"bytes"
	"reflect"
	"testing"
)

// The card helpers are what keeps a server-supplied string from repainting or
// overflowing the user's terminal, so every budget is exercised directly here.
// Through a whole-screen assertion an off-by-one in the ellipsis budget or a
// surviving control byte only shows up as a confusing frame diff.

// cardUTF8Caps takes the single-cell "…" path; the other two cover both legs of
// the `caps.Dumb || !caps.UTF8` guard that selects the three-dot fallback.
func cardUTF8Caps() Caps  { return Caps{UTF8: true} }
func cardDumbCaps() Caps  { return Caps{Dumb: true, UTF8: true} }
func cardASCIICaps() Caps { return Caps{} }

func TestCleanInlineStripsEscapesControlsAndFormatRunes(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		want string
	}{
		{name: "ansi colour stripped", in: "\x1b[31mred\x1b[0m", want: "red"},
		{name: "osc payload stripped", in: "\x1b]8;;https://evil.invalid\x07label\x1b]8;;\x07", want: "label"},
		{name: "tab and newline become spaces", in: "col\tone\nrow", want: "col one row"},
		{name: "carriage return cannot repaint the line", in: "safe\rforged", want: "safe forged"},
		{name: "bell becomes a space", in: "a\x07b", want: "a b"},
		{name: "nul becomes a space", in: "a\x00b", want: "a b"},
		{name: "delete becomes a space", in: "a\x7fb", want: "a b"},
		{name: "bidi override dropped", in: "safe\u202eforged", want: "safeforged"},
		{name: "left-to-right mark dropped", in: "\u200elabel", want: "label"},
		{name: "soft hyphen dropped", in: "de\u00adfault", want: "default"},
		{name: "zero-width space dropped", in: "zero\u200bwidth", want: "zerowidth"},
		{name: "whitespace runs collapsed", in: "  lots   of \t space  ", want: "lots of space"},
		{name: "empty", in: "", want: ""},
		{name: "only controls and blanks", in: " \x00\t\n ", want: ""},
		{name: "printable unicode kept", in: "café ✅ ⚡", want: "café ✅ ⚡"},
		{name: "combining mark kept", in: "e\u0301", want: "e\u0301"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := CleanInline(tc.in); got != tc.want {
				t.Errorf("CleanInline(%q) = %q want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestPlainInlineIsPortableASCII(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		want string
	}{
		{name: "spark", in: "⚡ ready", want: "spark ready"},
		{name: "right arrow", in: "a → b", want: "a -> b"},
		{name: "left arrow", in: "a ← b", want: "a <- b"},
		{name: "em dash", in: "a — b", want: "a - b"},
		{name: "en dash", in: "a – b", want: "a - b"},
		{name: "ellipsis", in: "wait…", want: "wait..."},
		{name: "check mark", in: "✓ synced", want: "OK synced"},
		{name: "multiplication sign", in: "× failed", want: "x failed"},
		{name: "ballot x", in: "✗ failed", want: "x failed"},
		{name: "up arrow", in: "↑ 3", want: "^ 3"},
		{name: "up arrow glyph", in: "⬆ 3", want: "^ 3"},
		{name: "middle dot", in: "a · b", want: "a | b"},
		{name: "unmapped accent falls back", in: "caf\u00e9", want: "caf?"},
		{name: "unmapped wide runes fall back", in: "日本", want: "??"},
		{name: "unmapped emoji falls back", in: "✅ done", want: "? done"},
		{name: "ascii passes through", in: "plain ascii 0123 !@#", want: "plain ascii 0123 !@#"},
		{name: "sanitized before mapping", in: "\x1b[31m✓\x1b[0m\tdone", want: "OK done"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := PlainInline(tc.in); got != tc.want {
				t.Errorf("PlainInline(%q) = %q want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestTruncateTextRespectsTheEllipsisBudget(t *testing.T) {
	for _, tc := range []struct {
		name  string
		in    string
		width int
		caps  Caps
		want  string
	}{
		{name: "fits unchanged", in: "hello", width: 10, caps: cardUTF8Caps(), want: "hello"},
		{name: "exact width unchanged", in: "hello", width: 5, caps: cardUTF8Caps(), want: "hello"},
		{name: "empty input", in: "", width: 5, caps: cardUTF8Caps(), want: ""},
		{name: "utf8 ellipsis", in: "hello world", width: 8, caps: cardUTF8Caps(), want: "hello w…"},
		{name: "dumb terminal spends three cells on dots", in: "hello world", width: 8, caps: cardDumbCaps(), want: "hello..."},
		{name: "non-utf8 locale spends three cells on dots", in: "hello world", width: 8, caps: cardASCIICaps(), want: "hello..."},
		{name: "trailing space trimmed before the ellipsis", in: "ab cdef", width: 4, caps: cardUTF8Caps(), want: "ab…"},
		{name: "width at the ellipsis width returns only dots", in: "hello", width: 1, caps: cardUTF8Caps(), want: "."},
		{name: "dumb width at the ellipsis width returns only dots", in: "hello", width: 3, caps: cardDumbCaps(), want: "..."},
		{name: "dumb width below the ellipsis width returns fewer dots", in: "hello", width: 2, caps: cardDumbCaps(), want: ".."},
		{name: "zero width", in: "hello", width: 0, caps: cardUTF8Caps(), want: ""},
		{name: "negative width", in: "hello", width: -5, caps: cardUTF8Caps(), want: ""},
		{name: "escapes stripped before measuring", in: "\x1b[31mred\x1b[0m alert", width: 20, caps: cardUTF8Caps(), want: "red alert"},
		{name: "controls collapse before truncation", in: "red\talert now", width: 9, caps: cardUTF8Caps(), want: "red aler…"},
		{name: "wide glyphs never straddle the budget", in: "日本語テキスト", width: 5, caps: cardUTF8Caps(), want: "日本…"},
		{name: "no wide glyph fits the dumb budget", in: "日本語", width: 4, caps: cardDumbCaps(), want: "..."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := TruncateText(tc.in, tc.width, tc.caps)
			if got != tc.want {
				t.Errorf("TruncateText(%q, %d) = %q want %q", tc.in, tc.width, got, tc.want)
			}
			if w := VisibleWidth(got); tc.width > 0 && w > tc.width {
				t.Errorf("TruncateText(%q, %d) = %q occupying %d cells, past the budget", tc.in, tc.width, got, w)
			}
		})
	}
}

func TestWrapTextNeverExceedsWidth(t *testing.T) {
	for _, tc := range []struct {
		name  string
		in    string
		width int
		want  []string
	}{
		{name: "empty input", in: "", width: 10, want: []string{""}},
		{name: "whitespace only", in: "   \t ", width: 10, want: []string{""}},
		{name: "zero width", in: "hello", width: 0, want: []string{""}},
		{name: "negative width", in: "hello", width: -3, want: []string{""}},
		{name: "fits on one line", in: "alpha beta", width: 10, want: []string{"alpha beta"}},
		{name: "wraps at the word boundary", in: "alpha beta gamma", width: 11, want: []string{"alpha beta", "gamma"}},
		{name: "word longer than width is split", in: "supercalifragilistic", width: 5, want: []string{"super", "calif", "ragil", "istic"}},
		{name: "long word flushes the pending line first", in: "hi supercalifragilistic", width: 5, want: []string{"hi", "super", "calif", "ragil", "istic"}},
		{name: "exact multiple leaves no empty tail", in: "abcdef", width: 3, want: []string{"abc", "def"}},
		{name: "wide glyphs split by cluster", in: "日本語", width: 4, want: []string{"日本", "語"}},
		{name: "sanitized before wrapping", in: "a\tb\nc", width: 3, want: []string{"a b", "c"}},
		{name: "escapes cost nothing against the width", in: "\x1b[31mred\x1b[0m alert", width: 5, want: []string{"red", "alert"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := WrapText(tc.in, tc.width)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("WrapText(%q, %d) = %q want %q", tc.in, tc.width, got, tc.want)
			}
			for _, line := range got {
				if w := VisibleWidth(line); tc.width > 0 && w > tc.width {
					t.Errorf("WrapText(%q, %d) produced %q occupying %d cells", tc.in, tc.width, line, w)
				}
			}
		})
	}
}

// splitVisible must always consume at least one rune, otherwise WrapText spins
// forever on a cluster that is wider than the whole terminal.
func TestSplitVisibleAlwaysMakesProgress(t *testing.T) {
	for _, tc := range []struct {
		name       string
		in         string
		width      int
		wantPrefix string
		wantRest   string
	}{
		{name: "zero width takes nothing", in: "hello", width: 0, wantPrefix: "", wantRest: "hello"},
		{name: "negative width takes nothing", in: "hello", width: -1, wantPrefix: "", wantRest: "hello"},
		{name: "empty string", in: "", width: 4, wantPrefix: "", wantRest: ""},
		{name: "splits mid string", in: "hello", width: 3, wantPrefix: "hel", wantRest: "lo"},
		{name: "exact width", in: "hello", width: 5, wantPrefix: "hello", wantRest: ""},
		{name: "width beyond the string", in: "hi", width: 10, wantPrefix: "hi", wantRest: ""},
		{name: "wide clusters do not straddle", in: "日本語", width: 4, wantPrefix: "日本", wantRest: "語"},
		{name: "over-wide first cluster still advances", in: "日本", width: 1, wantPrefix: "日", wantRest: "本"},
		{name: "over-wide spark still advances", in: "⚡ok", width: 1, wantPrefix: "⚡", wantRest: "ok"},
		{name: "combining mark stays with its base", in: "e\u0301x", width: 1, wantPrefix: "e\u0301", wantRest: "x"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prefix, rest := splitVisible(tc.in, tc.width)
			if prefix != tc.wantPrefix || rest != tc.wantRest {
				t.Errorf("splitVisible(%q, %d) = (%q, %q) want (%q, %q)",
					tc.in, tc.width, prefix, rest, tc.wantPrefix, tc.wantRest)
			}
			if prefix+rest != tc.in {
				t.Errorf("splitVisible(%q, %d) lost text: %q + %q", tc.in, tc.width, prefix, rest)
			}
			if tc.width > 0 && tc.in != "" && prefix == "" {
				t.Errorf("splitVisible(%q, %d) made no progress", tc.in, tc.width)
			}
		})
	}
}

func TestJoinSidesKeepsTheRightEdgeWithinWidth(t *testing.T) {
	for _, tc := range []struct {
		name      string
		left      string
		right     string
		width     int
		caps      Caps
		want      string
		wantWidth int
	}{
		{name: "pads between the sides", left: "L", right: "R", width: 10, caps: cardUTF8Caps(), want: "L        R", wantWidth: 10},
		{name: "left exactly fills its budget", left: "12345678", right: "R", width: 10, caps: cardUTF8Caps(), want: "12345678 R", wantWidth: 10},
		{name: "empty left is all padding", left: "", right: "R", width: 5, caps: cardUTF8Caps(), want: "    R", wantWidth: 5},
		{name: "empty right keeps the left padded", left: "L", right: "", width: 6, caps: cardUTF8Caps(), want: "L     ", wantWidth: 6},
		{name: "wider right leaves a single gap", left: "LL", right: "RRR", width: 6, caps: cardUTF8Caps(), want: "LL RRR", wantWidth: 6},
		{name: "left truncated to protect the right", left: "a very long left side", right: "R", width: 10, caps: cardUTF8Caps(), want: "a very…  R", wantWidth: 10},
		{name: "left truncated on a dumb terminal", left: "a very long left side", right: "R", width: 10, caps: cardDumbCaps(), want: "a ver... R", wantWidth: 10},
		{name: "right alone when it fills the width", left: "left", right: "0123456789", width: 10, caps: cardUTF8Caps(), want: "0123456789", wantWidth: 10},
		{name: "right truncated when it overflows", left: "left", right: "0123456789", width: 8, caps: cardUTF8Caps(), want: "0123456…", wantWidth: 8},
		{name: "styled left keeps its escapes while it fits", left: "\x1b[1mL\x1b[0m", right: "R", width: 10, caps: cardUTF8Caps(), want: "\x1b[1mL\x1b[0m        R", wantWidth: 10},
		{name: "zero width", left: "L", right: "R", width: 0, caps: cardUTF8Caps(), want: "", wantWidth: 0},
		{name: "negative width", left: "L", right: "R", width: -4, caps: cardUTF8Caps(), want: "", wantWidth: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := joinSides(tc.left, tc.right, tc.width, tc.caps)
			if got != tc.want {
				t.Errorf("joinSides(%q, %q, %d) = %q want %q", tc.left, tc.right, tc.width, got, tc.want)
			}
			if w := VisibleWidth(got); w != tc.wantWidth {
				t.Errorf("joinSides(%q, %q, %d) = %q occupying %d cells want %d",
					tc.left, tc.right, tc.width, got, w, tc.wantWidth)
			}
		})
	}
}

func TestPackPiecesFillsLinesWithinWidth(t *testing.T) {
	for _, tc := range []struct {
		name   string
		pieces []string
		width  int
		gap    int
		want   []string
	}{
		{name: "zero width", pieces: []string{"a"}, width: 0, gap: 1, want: nil},
		{name: "negative width", pieces: []string{"a"}, width: -2, gap: 1, want: nil},
		{name: "blank pieces skipped", pieces: []string{"", "   ", "\x1b[0m", "a"}, width: 10, gap: 1, want: []string{"a"}},
		{name: "all blank yields no lines", pieces: []string{"", " "}, width: 10, gap: 1, want: []string{}},
		{name: "exact fit stays on one line", pieces: []string{"aaa", "bbb"}, width: 7, gap: 1, want: []string{"aaa bbb"}},
		{name: "overflow starts a new line", pieces: []string{"aaa", "bbb"}, width: 6, gap: 1, want: []string{"aaa", "bbb"}},
		{name: "gap counted against the width", pieces: []string{"aaa", "bbb", "ccc"}, width: 8, gap: 2, want: []string{"aaa  bbb", "ccc"}},
		{name: "zero gap packs tighter", pieces: []string{"aa", "bb"}, width: 4, gap: 0, want: []string{"aabb"}},
		{name: "an over-wide piece is never split", pieces: []string{"aaaaaaaa"}, width: 4, gap: 1, want: []string{"aaaaaaaa"}},
		{name: "styled pieces cost only their visible cells", pieces: []string{"\x1b[31mred\x1b[0m", "blue"}, width: 8, gap: 1, want: []string{"\x1b[31mred\x1b[0m blue"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := packPieces(tc.pieces, tc.width, tc.gap); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("packPieces(%q, %d, gap=%d) = %q want %q", tc.pieces, tc.width, tc.gap, got, tc.want)
			}
		})
	}
}

func TestPackSeparatedPiecesFillsLinesWithinWidth(t *testing.T) {
	for _, tc := range []struct {
		name      string
		pieces    []string
		width     int
		separator string
		want      []string
	}{
		{name: "zero width", pieces: []string{"a"}, width: 0, separator: " · ", want: nil},
		{name: "negative width", pieces: []string{"a"}, width: -2, separator: " · ", want: nil},
		{name: "blank pieces skipped", pieces: []string{"", "  ", "\x1b[0m", "a"}, width: 10, separator: " · ", want: []string{"a"}},
		{name: "all blank yields no lines", pieces: []string{"", "\x1b[0m"}, width: 10, separator: " · ", want: []string{}},
		{name: "separator counted against the width", pieces: []string{"alpha", "beta", "gamma"}, width: 12, separator: " · ", want: []string{"alpha · beta", "gamma"}},
		{name: "overflow starts a new line", pieces: []string{"alpha", "beta"}, width: 11, separator: " · ", want: []string{"alpha", "beta"}},
		{name: "empty separator packs tighter", pieces: []string{"a", "b"}, width: 2, separator: "", want: []string{"ab"}},
		{name: "pieces are sanitized", pieces: []string{"  spaced   out ", "\x1b[31mred\x1b[0m"}, width: 20, separator: " | ", want: []string{"spaced out | red"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := packSeparatedPieces(tc.pieces, tc.width, tc.separator)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("packSeparatedPieces(%q, %d, %q) = %q want %q",
					tc.pieces, tc.width, tc.separator, got, tc.want)
			}
		})
	}
}

// fitStyled owns the inner cell of every card row: anything but an exact width
// shifts the right border of the frame.
func TestFitStyledPadsToExactlyWidth(t *testing.T) {
	for _, tc := range []struct {
		name  string
		in    string
		width int
		caps  Caps
		want  string
	}{
		{name: "zero width", in: "abc", width: 0, caps: cardUTF8Caps(), want: ""},
		{name: "negative width", in: "abc", width: -3, caps: cardUTF8Caps(), want: ""},
		{name: "empty input is all padding", in: "", width: 4, caps: cardUTF8Caps(), want: "    "},
		{name: "short input padded", in: "ab", width: 5, caps: cardUTF8Caps(), want: "ab   "},
		{name: "exact width untouched", in: "hello", width: 5, caps: cardUTF8Caps(), want: "hello"},
		{name: "over-long input truncated to the frame", in: "hello world", width: 5, caps: cardUTF8Caps(), want: "hell…"},
		{name: "over-long input on a dumb terminal", in: "hello world", width: 8, caps: cardDumbCaps(), want: "hello..."},
		{name: "styled input keeps its escapes while it fits", in: "\x1b[1mhi\x1b[0m", width: 4, caps: cardUTF8Caps(), want: "\x1b[1mhi\x1b[0m  "},
		{name: "over-long styled input loses its escapes", in: "\x1b[1mhello world\x1b[0m", width: 6, caps: cardUTF8Caps(), want: "hello…"},
		{name: "wide glyph short of the frame gets padded", in: "日本語", width: 4, caps: cardUTF8Caps(), want: "日… "},
		{name: "controls sanitized on the truncation path", in: "a\rb c d", width: 4, caps: cardUTF8Caps(), want: "a b…"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := fitStyled(tc.in, tc.width, tc.caps)
			if got != tc.want {
				t.Errorf("fitStyled(%q, %d) = %q want %q", tc.in, tc.width, got, tc.want)
			}
			want := tc.width
			if want < 0 {
				want = 0
			}
			if w := VisibleWidth(got); w != want {
				t.Errorf("fitStyled(%q, %d) = %q occupying %d cells want exactly %d", tc.in, tc.width, got, w, want)
			}
		})
	}
}

func TestLimitWrappedLinesCapsWithAnEllipsis(t *testing.T) {
	for _, tc := range []struct {
		name     string
		lines    []string
		maxLines int
		width    int
		caps     Caps
		want     []string
	}{
		{name: "no cap when maxLines is zero", lines: []string{"one", "two", "three"}, maxLines: 0, width: 10, caps: cardUTF8Caps(), want: []string{"one", "two", "three"}},
		{name: "no cap when maxLines is negative", lines: []string{"one", "two", "three"}, maxLines: -1, width: 10, caps: cardUTF8Caps(), want: []string{"one", "two", "three"}},
		{name: "under the cap is untouched", lines: []string{"one", "two"}, maxLines: 3, width: 10, caps: cardUTF8Caps(), want: []string{"one", "two"}},
		{name: "at the cap is untouched", lines: []string{"one", "two"}, maxLines: 2, width: 10, caps: cardUTF8Caps(), want: []string{"one", "two"}},
		{name: "ellipsis appended at the cap", lines: []string{"one", "two", "three"}, maxLines: 2, width: 10, caps: cardUTF8Caps(), want: []string{"one", "two…"}},
		{name: "dumb ellipsis appended at the cap", lines: []string{"one", "two", "three"}, maxLines: 2, width: 10, caps: cardDumbCaps(), want: []string{"one", "two..."}},
		{name: "non-utf8 ellipsis appended at the cap", lines: []string{"one", "two", "three"}, maxLines: 2, width: 10, caps: cardASCIICaps(), want: []string{"one", "two..."}},
		{name: "only the kept last line is trimmed", lines: []string{"one  ", "two  ", "three"}, maxLines: 2, width: 10, caps: cardUTF8Caps(), want: []string{"one  ", "two…"}},
		{name: "exactly enough room keeps the whole line", lines: []string{"abcdefghi", "x"}, maxLines: 1, width: 10, caps: cardUTF8Caps(), want: []string{"abcdefghi…"}},
		{name: "last line shortened to make room", lines: []string{"abcdefghij", "x"}, maxLines: 1, width: 10, caps: cardUTF8Caps(), want: []string{"abcdefghi…"}},
		{name: "dumb last line shortened to make room", lines: []string{"abcdefghij", "x"}, maxLines: 1, width: 10, caps: cardDumbCaps(), want: []string{"abcdefg..."}},
		{name: "narrow width falls back to dots", lines: []string{"abc", "d"}, maxLines: 1, width: 1, caps: cardUTF8Caps(), want: []string{"."}},
		{name: "narrow dumb width falls back to dots", lines: []string{"abc", "d"}, maxLines: 1, width: 2, caps: cardDumbCaps(), want: []string{".."}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := limitWrappedLines(tc.lines, tc.maxLines, tc.width, tc.caps)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("limitWrappedLines(%q, max=%d, width=%d) = %q want %q",
					tc.lines, tc.maxLines, tc.width, got, tc.want)
			}
			for _, line := range got {
				if w := VisibleWidth(line); w > tc.width {
					t.Errorf("limitWrappedLines(%q, max=%d, width=%d) produced %q occupying %d cells",
						tc.lines, tc.maxLines, tc.width, line, w)
				}
			}
		})
	}

	// The cap copies before it rewrites, so the caller's slice keeps its lines.
	input := []string{"one", "two", "three"}
	limitWrappedLines(input, 2, 10, cardUTF8Caps())
	if !reflect.DeepEqual(input, []string{"one", "two", "three"}) {
		t.Errorf("limitWrappedLines mutated its input: %q", input)
	}
}

func TestNewCardClampsWidthToTheFrameBounds(t *testing.T) {
	for _, tc := range []struct {
		name      string
		columns   int
		wantWidth int
		wantInner int
	}{
		{name: "typical terminal", columns: 80, wantWidth: 78, wantInner: 74},
		{name: "one column under the cap", columns: 93, wantWidth: 91, wantInner: 87},
		{name: "exactly at the cap", columns: 94, wantWidth: maxCardWidth, wantInner: maxCardWidth - 4},
		{name: "one column over the cap", columns: 95, wantWidth: maxCardWidth, wantInner: maxCardWidth - 4},
		{name: "very wide terminal", columns: 400, wantWidth: maxCardWidth, wantInner: maxCardWidth - 4},
		{name: "just above the floor", columns: 8, wantWidth: 6, wantInner: 2},
		{name: "exactly at the floor", columns: 6, wantWidth: 4, wantInner: 0},
		{name: "below the floor", columns: 5, wantWidth: 4, wantInner: 0},
		{name: "zero columns", columns: 0, wantWidth: 4, wantInner: 0},
		{name: "negative columns", columns: -20, wantWidth: 4, wantInner: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			c := newCard(&buf, Caps{Columns: tc.columns})
			if c.width != tc.wantWidth || c.inner != tc.wantInner {
				t.Errorf("newCard(columns=%d) width=%d inner=%d want %d/%d",
					tc.columns, c.width, c.inner, tc.wantWidth, tc.wantInner)
			}
		})
	}
}

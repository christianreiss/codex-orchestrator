package ui

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
)

// healthMode pins the glyphs one capability set must produce, so a tone that
// collapsed onto another tone's shape cannot pass unnoticed.
type healthMode struct {
	name string
	caps Caps
	ok   string
	warn string
	fail string
	dim  string
	up   string
}

// healthModes covers the UTF-8 path plus both triggers of the ASCII fallback
// in toneSymbol (caps.Dumb || !caps.UTF8). The palette stays empty so the rows
// can be compared byte for byte.
func healthModes() []healthMode {
	return []healthMode{
		{
			name: "utf8",
			caps: Caps{IsTTY: true, NoColor: true, UTF8: true, Columns: 80},
			ok:   "✓", warn: "!", fail: "×", dim: "·", up: "↑",
		},
		{
			name: "dumb",
			caps: Caps{NoColor: true, Dumb: true, UTF8: true, Columns: 80},
			ok:   "OK", warn: "!", fail: "X", dim: "-", up: "^",
		},
		{
			name: "non-utf8",
			caps: Caps{IsTTY: true, NoColor: true, Columns: 80},
			ok:   "OK", warn: "!", fail: "X", dim: "-", up: "^",
		},
	}
}

func (m healthMode) toneGlyphs() map[Tone]string {
	return map[Tone]string{ToneOK: m.ok, ToneWarn: m.warn, ToneFail: m.fail, ToneDim: m.dim}
}

func TestToneSymbolKeepsEveryToneAndTheUpdateMarkerDistinct(t *testing.T) {
	for _, mode := range healthModes() {
		t.Run(mode.name, func(t *testing.T) {
			seen := map[string]Tone{}
			for tone, want := range mode.toneGlyphs() {
				got := toneSymbol(mode.caps, tone, false)
				if got != want {
					t.Errorf("toneSymbol(%q) = %q want %q", tone, got, want)
				}
				if other, dup := seen[got]; dup {
					t.Errorf("tones %q and %q share glyph %q", other, tone, got)
				}
				seen[got] = tone

				// The marker is a suffix in its own right: it never varies
				// with the tone it is attached to.
				if updated := toneSymbol(mode.caps, tone, true); updated != mode.up {
					t.Errorf("toneSymbol(%q, updated) = %q want %q", tone, updated, mode.up)
				}
			}
			if tone, clash := seen[mode.up]; clash {
				t.Errorf("update marker %q is also the glyph for tone %q", mode.up, tone)
			}
		})
	}
}

func TestPrintHealthRowSkipsUnnamedDotsAndKeepsOrder(t *testing.T) {
	for _, mode := range healthModes() {
		t.Run(mode.name, func(t *testing.T) {
			for _, c := range []struct {
				name string
				dots []HealthDot
			}{
				{"no dots", nil},
				{"empty slice", []HealthDot{}},
				{"every dot skipped", []HealthDot{{Tone: ToneFail, Updated: true}, {Tone: ToneOK}}},
			} {
				var buf bytes.Buffer
				PrintHealthRow(&buf, mode.caps, c.dots)
				if buf.Len() != 0 {
					t.Errorf("%s wrote %q, want no row at all", c.name, buf.String())
				}
			}

			var buf bytes.Buffer
			PrintHealthRow(&buf, mode.caps, []HealthDot{
				{Name: "api", Tone: ToneOK},
				{Name: "", Tone: ToneFail, Updated: true},
				{Name: "auth", Tone: ToneWarn, Updated: true},
				{Name: "skills", Tone: ToneFail},
				{Name: "runner", Tone: ToneDim},
			})
			want := fmt.Sprintf("  %s api  %s auth %s  %s skills  %s runner\n",
				mode.ok, mode.warn, mode.up, mode.fail, mode.dim)
			if got := buf.String(); got != want {
				t.Fatalf("health row = %q want %q", got, want)
			}
			if got := strings.Count(buf.String(), mode.up); got != 1 {
				t.Errorf("update marker %q appears %d times, want it only on the dot that carries it", mode.up, got)
			}
		})
	}
}

func TestPrintConcurrentRowSubstitutesItsDefaultNote(t *testing.T) {
	caps := healthModes()[0].caps

	var buf bytes.Buffer
	PrintConcurrentRow(&buf, caps, "")
	if got, want := buf.String(), "  concurrent  Managed content sync paused; auth freshness remains active.\n"; got != want {
		t.Fatalf("empty note = %q want %q", got, want)
	}

	buf.Reset()
	PrintConcurrentRow(&buf, caps, "another instance holds the sync lock")
	if got, want := buf.String(), "  concurrent  another instance holds the sync lock\n"; got != want {
		t.Fatalf("supplied note = %q want %q", got, want)
	}
}

func TestPrintResultNeedsALabelAndCarriesTheToneGlyph(t *testing.T) {
	for _, mode := range healthModes() {
		t.Run(mode.name, func(t *testing.T) {
			var buf bytes.Buffer
			PrintResult(&buf, mode.caps, "", ToneFail)
			if buf.Len() != 0 {
				t.Errorf("empty label wrote %q, want no tagline", buf.String())
			}

			for tone, glyph := range mode.toneGlyphs() {
				buf.Reset()
				PrintResult(&buf, mode.caps, "ready", tone)
				if got, want := buf.String(), "  "+glyph+" ready\n"; got != want {
					t.Errorf("PrintResult(%q) = %q want %q", tone, got, want)
				}
			}
		})
	}
}

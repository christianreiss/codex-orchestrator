package ui

import (
	"strings"
	"testing"
	"time"
)

// barCaps renders bars with unambiguous ASCII glyphs and no escapes so a test
// can count fill cells directly.
func barCaps() Caps {
	return Caps{BannerSym: BannerGlyphs{BarFill: "#", BarEmpty: "-"}}
}

func TestProjectionReadyHonorsBothFloors(t *testing.T) {
	// A 1h window: 1% is 36s, so the five-minute floor is the binding one.
	// A 7d window: 1% is 6048s, well past five minutes, so it binds instead.
	const hour = int64(3600)
	const week = int64(7 * 24 * 3600)

	cases := []struct {
		name       string
		limit      int64
		resetAfter int64
		want       bool
	}{
		{"zero limit", 0, hour, false},
		{"negative limit", -1, hour, false},
		{"zero reset", hour, 0, false},
		{"negative reset", hour, -1, false},
		{"fresh window", hour, hour, false},

		{"five-minute floor just below", hour, hour - 299, false},
		{"five-minute floor exactly", hour, hour - 300, true},
		{"five-minute floor just above", hour, hour - 301, true},

		{"one-percent floor just below", week, week - 6047, false},
		{"one-percent floor exactly", week, week - 6048, true},
		{"one-percent floor just above", week, week - 6049, true},

		// At a 500-minute window the two floors coincide at 300s.
		{"floors coincide just below", 30000, 30000 - 299, false},
		{"floors coincide exactly", 30000, 30000 - 300, true},

		// Below the crossover the 1% floor must not win: 1% of 10m is 6s.
		{"one percent does not undercut five minutes", 600, 594, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ProjectionReady(c.limit, c.resetAfter); got != c.want {
				t.Errorf("ProjectionReady(%d, %d) = %t want %t", c.limit, c.resetAfter, got, c.want)
			}
		})
	}
}

func TestProjectUsageExtrapolatesOnlyWhenReady(t *testing.T) {
	const hour = int64(3600)
	const week = int64(7 * 24 * 3600)

	cases := []struct {
		name       string
		used       int
		limit      int64
		resetAfter int64
		want       int
	}{
		{"zero used", 0, hour, hour / 2, 0},
		{"negative used", -5, hour, hour / 2, -5},
		{"zero limit", 10, 0, hour / 2, 10},
		{"negative limit", 10, -1, hour / 2, 10},
		{"zero reset", 10, hour, 0, 10},
		{"negative reset", 10, hour, -1, 10},

		{"not ready keeps used", 10, hour, hour - 299, 10},
		{"ready at the floor extrapolates", 10, hour, hour - 300, 120},

		{"half window doubles", 10, hour, hour / 2, 20},
		{"half week doubles", 25, week, week / 2, 50},
		{"projection may exceed 100", 60, hour, hour / 2, 120},
		{"quarter elapsed quadruples", 5, hour, 2700, 20},
		{"fractional projection truncates", 2, hour, 2100, 4},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ProjectUsage(c.used, c.limit, c.resetAfter); got != c.want {
				t.Errorf("ProjectUsage(%d, %d, %d) = %d want %d", c.used, c.limit, c.resetAfter, got, c.want)
			}
		})
	}
}

func TestProjectETAReturnsTimeToHundredOnlyWhenProjectionCrosses(t *testing.T) {
	const hour = int64(3600)
	const week = int64(7 * 24 * 3600)

	cases := []struct {
		name       string
		used       int
		limit      int64
		resetAfter int64
		want       time.Duration
	}{
		{"zero used", 0, hour, hour / 2, 0},
		{"negative used", -5, hour, hour / 2, 0},
		{"already at 100", 100, hour, hour / 2, 0},
		{"above 100", 120, hour, hour / 2, 0},
		{"zero limit", 50, 0, hour / 2, 0},
		{"zero reset", 50, hour, 0, 0},

		{"not ready", 50, hour, hour - 299, 0},
		{"projection below 100", 10, hour, hour / 2, 0},
		{"projection below 100 on weekly", 40, week, week / 2, 0},

		{"projection exactly 100", 50, hour, hour / 2, 30 * time.Minute},
		{"burning twice as fast", 60, hour, hour / 2, 20 * time.Minute},
		{"weekly burn", 70, week, week / 2, 36 * time.Hour},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ProjectETA(c.used, c.limit, c.resetAfter); got != c.want {
				t.Errorf("ProjectETA(%d, %d, %d) = %s want %s", c.used, c.limit, c.resetAfter, got, c.want)
			}
		})
	}
}

func TestClassifyPctThresholdsAndDefaults(t *testing.T) {
	cases := []struct {
		name  string
		pct   int
		warn  int
		block int
		want  Tone
	}{
		{"default empty", 0, 0, 0, ToneOK},
		{"default below warn", 79, 0, 0, ToneOK},
		{"default at warn", 80, 0, 0, ToneWarn},
		{"default below block", 94, 0, 0, ToneWarn},
		{"default at block", 95, 0, 0, ToneFail},
		{"default above block", 100, 0, 0, ToneFail},
		{"default negative", -10, 0, 0, ToneOK},

		{"warn defaulted, block explicit, below warn", 79, 0, 90, ToneOK},
		{"warn defaulted, block explicit, at warn", 80, 0, 90, ToneWarn},
		{"warn defaulted, block explicit, at block", 90, 0, 90, ToneFail},

		{"warn explicit, block defaulted, at warn", 50, 50, 0, ToneWarn},
		{"warn explicit, block defaulted, below block", 94, 50, 0, ToneWarn},
		{"warn explicit, block defaulted, at block", 95, 50, 0, ToneFail},

		{"explicit below warn", 49, 50, 70, ToneOK},
		{"explicit at warn", 50, 50, 70, ToneWarn},
		{"explicit below block", 69, 50, 70, ToneWarn},
		{"explicit at block", 70, 50, 70, ToneFail},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := classifyPct(c.pct, c.warn, c.block); got != c.want {
				t.Errorf("classifyPct(%d, %d, %d) = %q want %q", c.pct, c.warn, c.block, got, c.want)
			}
		})
	}
}

func TestBuildBarFillRoundsAndClamps(t *testing.T) {
	caps := barCaps()

	cases := []struct {
		name  string
		pct   int
		width int
		want  int // filled cells
	}{
		{"empty", 0, BarWidth, 0},
		{"half rounds up", 50, BarWidth, 12},
		{"full", 100, BarWidth, BarWidth},
		{"rounds down below half a cell", 2, BarWidth, 0},
		{"rounds up past half a cell", 3, BarWidth, 1},
		{"negative clamps to empty", -10, BarWidth, 0},
		{"over 100 clamps to full", 150, BarWidth, BarWidth},
		{"narrow bar half", 50, 6, 3},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			bar := buildBar(caps, c.pct, c.width, 0, 0)
			filled := strings.Count(bar, "#")
			empty := strings.Count(bar, "-")
			if filled != c.want || filled+empty != c.width {
				t.Errorf("buildBar(%d, width=%d) = %q (%d filled, %d empty) want %d filled of %d",
					c.pct, c.width, bar, filled, empty, c.want, c.width)
			}
		})
	}
}

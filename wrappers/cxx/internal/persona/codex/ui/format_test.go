package ui

import (
	"strings"
	"testing"
	"time"
)

func TestCompactNumber(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{0, "0"},
		{42, "42"},
		{999, "999"},
		{1_000, "1K"},
		{1_500, "1.5K"},
		{12_345, "12K"},
		{1_000_000, "1M"},
		{1_500_000, "1.5M"},
		{10_000_000, "10M"},
	}
	for _, c := range cases {
		if got := CompactNumber(c.in); got != c.want {
			t.Errorf("CompactNumber(%d) = %q want %q", c.in, got, c.want)
		}
	}
}

func TestGroupedInt(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{0, "0"},
		{12, "12"},
		{1_000, "1,000"},
		{12_345, "12,345"},
		{1_234_567, "1,234,567"},
	}
	for _, c := range cases {
		if got := GroupedInt(c.in); got != c.want {
			t.Errorf("GroupedInt(%d) = %q want %q", c.in, got, c.want)
		}
	}
}

func TestDurationShort(t *testing.T) {
	cases := []struct {
		in   time.Duration
		want string
	}{
		{0, "<1m"},
		{30 * time.Second, "<1m"},
		{1 * time.Minute, "1m"},
		{2 * time.Hour, "2h"},
		{2*time.Hour + 30*time.Minute, "2h 30m"},
		{25 * time.Hour, "1d 1h"},
		{72 * time.Hour, "3d"},
	}
	for _, c := range cases {
		if got := DurationShort(c.in); got != c.want {
			t.Errorf("DurationShort(%v) = %q want %q", c.in, got, c.want)
		}
	}
}

func TestVisibleWidth(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"hello", 5},
		{"", 0},
		{"\033[31mred\033[0m", 3},
		{"⚡", 2},
		{"✓", 1},
		{"⚠", 1},
		{"⚠️", 2},
		{"e\u0301", 1},
		{"👨‍👩‍👧‍👦", 2},
	}
	for _, c := range cases {
		if got := VisibleWidth(c.in); got != c.want {
			t.Errorf("VisibleWidth(%q) = %d want %d", c.in, got, c.want)
		}
	}
}

func TestLocalePrecedenceAndBidiSanitization(t *testing.T) {
	t.Setenv("LC_ALL", "C")
	t.Setenv("LC_CTYPE", "")
	t.Setenv("LANG", "en_US.UTF-8")
	if looksUTF8() {
		t.Fatal("LC_ALL=C must override a UTF-8 LANG")
	}
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_CTYPE", "C.UTF-8")
	t.Setenv("LANG", "C")
	if !looksUTF8() {
		t.Fatal("LC_CTYPE=C.UTF-8 must override LANG=C")
	}
	if got := CleanInline("safe\u202eforged"); got != "safeforged" {
		t.Fatalf("bidi control survived sanitization: %q", got)
	}
}

func TestProjectUsage(t *testing.T) {
	// 50% in 1h elapsed (4h remaining); projection = 50 + 50/1 * 4 = 250.
	if got := ProjectUsage(50, int64(5*3600), int64(4*3600)); got != 250 {
		t.Errorf("ProjectUsage(50,5h,4h) = %d want 250", got)
	}
	// Used <= 0 returns input.
	if got := ProjectUsage(0, 100, 50); got != 0 {
		t.Errorf("ProjectUsage(0,…) = %d want 0", got)
	}
	if got := ProjectUsage(1, int64(5*time.Hour/time.Second), int64(5*time.Hour/time.Second)-1); got != 1 {
		t.Errorf("near-fresh ProjectUsage = %d, want current 1", got)
	}
}

func TestProjectETA(t *testing.T) {
	// 50% used after 1h, 4h remain. ETA-to-100 = remaining/rate = 50 / (50/3600) = 3600s = 1h.
	got := ProjectETA(50, int64(5*3600), int64(4*3600))
	if got != time.Hour {
		t.Errorf("ProjectETA(50,5h,4h) = %v want 1h", got)
	}
	// If projection < 100 returns 0.
	if got := ProjectETA(10, int64(5*3600), int64(4*3600)); got != 0 {
		t.Errorf("ProjectETA(10,…) = %v want 0", got)
	}
}

func TestFormatQuotaLineHonorsProjectionTone(t *testing.T) {
	caps := Caps{
		Palette:   Palette{Bold: "\x1b[1m", Dim: "\x1b[2m", Reset: "\x1b[0m", Green: "\x1b[32m", Orange: "\x1b[33m", Red: "\x1b[31m"},
		BannerSym: BannerGlyphs{BarFill: "#", BarEmpty: "-"},
	}
	for _, tc := range []struct {
		tone Tone
		want string
	}{
		{tone: ToneDim, want: "\x1b[2mforecast ~47% at reset\x1b[0m"},
		{tone: ToneWarn, want: "\x1b[33m\x1b[1mforecast ~47% at reset\x1b[0m"},
		{tone: ToneFail, want: "\x1b[31m\x1b[1mforecast ~47% at reset\x1b[0m"},
	} {
		line := formatQuotaLine(caps, QuotaRow{Label: "5h", Used: 20, Projection: "~47% at reset", ProjectionTone: tc.tone}, 80)
		if !strings.Contains(line, tc.want) {
			t.Fatalf("projection tone %q not rendered: %q", tc.tone, line)
		}
	}
}

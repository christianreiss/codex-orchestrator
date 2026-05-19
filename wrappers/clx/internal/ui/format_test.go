package ui

import (
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
	}
	for _, c := range cases {
		if got := VisibleWidth(c.in); got != c.want {
			t.Errorf("VisibleWidth(%q) = %d want %d", c.in, got, c.want)
		}
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

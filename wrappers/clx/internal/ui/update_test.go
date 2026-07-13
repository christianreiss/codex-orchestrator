package ui

import (
	"errors"
	"strings"
	"testing"
)

func TestUpdateLinesAreUniformAndColoured(t *testing.T) {
	caps := Caps{
		UTF8: true,
		Palette: Palette{
			Bold: "\033[1m", Dim: "\033[2m", Reset: "\033[0m",
			Cyan: "\033[96m", Green: "\033[32m", Red: "\033[31m",
		},
	}
	cases := []struct {
		name  string
		line  string
		want  string
		color string
	}{
		{"progress", UpdateProgress(caps, "clx", "wrapper", "0.6.41", "0.6.42"), "↻ · clx · wrapper · 0.6.41 → 0.6.42 · updating…", "\033[96m"},
		{"complete", UpdateComplete(caps, "clx", "wrapper", "0.6.42", true), "✓ · clx · wrapper · 0.6.42 · updated, restarting…", "\033[32m"},
		{"install", UpdateProgress(caps, "clx", "cdx", "", ""), "↻ · clx · cdx · installing…", "\033[96m"},
		{"failure", UpdateFailure(caps, "clx", "wrapper", "0.6.42", errors.New("checksum mismatch")), "✗ · clx · wrapper · 0.6.42 · update skipped: checksum mismatch", "\033[31m"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if !strings.Contains(tc.line, tc.color) {
				t.Fatalf("%s line is missing colour: %q", tc.name, tc.line)
			}
			if got := StripANSI(tc.line); got != tc.want {
				t.Fatalf("%s line = %q, want %q", tc.name, got, tc.want)
			}
		})
	}
}

func TestUpdateLinesUseAsciiInDumbTerminals(t *testing.T) {
	caps := Caps{Dumb: true}
	if got, want := UpdateProgress(caps, "clx", "wrapper", "0.6.41", "0.6.42"), "~ · clx · wrapper · 0.6.41 -> 0.6.42 · updating..."; got != want {
		t.Fatalf("UpdateProgress() = %q, want %q", got, want)
	}
}

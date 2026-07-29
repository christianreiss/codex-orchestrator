package ui

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestExitFooterNeverGreensAFailedRun(t *testing.T) {
	caps := footerCaps(80)
	var buf bytes.Buffer
	PrintExitFooter(&buf, caps, "wrap", ExitFooter{ExitCode: 3, AuthStatus: "uploaded", AuthTone: ToneOK})
	out := buf.String()
	if want := caps.Palette.Red + caps.Palette.Bold + "EXIT 3" + caps.Palette.Reset; !strings.Contains(out, want) {
		t.Fatalf("failed run missing fail tone %q:\n%q", want, out)
	}
	if green := caps.Palette.Green + caps.Palette.Bold + "EXIT"; strings.Contains(out, green) {
		t.Fatalf("failed run ended on a green summary:\n%q", out)
	}
	if plain := StripANSI(out); strings.Contains(plain, "AUTH FAILED") || strings.Contains(plain, "ATTENTION") {
		t.Fatalf("healthy auth added an outcome suffix:\n%q", plain)
	}
}

func TestExitFooterEscalatesAuthOutcomeOnACleanExit(t *testing.T) {
	caps := footerCaps(80)
	for _, tc := range []struct {
		name    string
		tone    Tone
		colour  string
		outcome string
	}{
		{"auth_failed", ToneFail, caps.Palette.Red, "AUTH FAILED"},
		{"auth_warning", ToneWarn, caps.Palette.Orange, "ATTENTION"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			PrintExitFooter(&buf, caps, "wrap", ExitFooter{AuthStatus: "upload failed", AuthTone: tc.tone})
			want := tc.colour + caps.Palette.Bold + "EXIT 0" + richSeparator(caps) + tc.outcome + caps.Palette.Reset
			if !strings.Contains(buf.String(), want) {
				t.Fatalf("footer missing %q:\n%q", want, buf.String())
			}
		})
	}
}

func TestExitFooterReportsBlankAuthStatusAsUnchanged(t *testing.T) {
	caps := footerCaps(80)
	var rich bytes.Buffer
	PrintExitFooter(&rich, caps, "wrap", ExitFooter{})
	if !strings.Contains(StripANSI(rich.String()), "auth unchanged") {
		t.Fatalf("rich footer lost the auth default:\n%q", rich.String())
	}

	plainCaps := caps
	plainCaps.IsTTY = false
	var plain bytes.Buffer
	PrintExitFooter(&plain, plainCaps, "wrap", ExitFooter{})
	if got, want := plain.String(), "wrap | exit=0 | duration=<1s | auth=unchanged\n"; got != want {
		t.Fatalf("plain footer = %q, want %q", got, want)
	}
}

func TestExitFooterUsesThePlainLineForEveryDegradedTerminal(t *testing.T) {
	for _, tc := range []struct {
		name    string
		degrade func(Caps) Caps
	}{
		{"redirected", func(c Caps) Caps { c.IsTTY = false; return c }},
		{"dumb", func(c Caps) Caps { c.Dumb = true; return c }},
		{"narrow", func(c Caps) Caps { c.Columns = minRichColumns - 1; return c }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			PrintExitFooter(&buf, tc.degrade(footerCaps(80)), "wrap", ExitFooter{
				RunDuration: 7 * time.Second, ExitCode: 2, AuthStatus: "ok", AuthTone: ToneFail,
			})
			if got, want := buf.String(), "wrap | exit=2 | duration=7s | auth=ok\n"; got != want {
				t.Fatalf("plain footer = %q, want %q", got, want)
			}
		})
	}
}

func TestExitFooterPlainEngineFieldNeedsBothNameAndVersion(t *testing.T) {
	caps := footerCaps(80)
	caps.IsTTY = false
	for _, tc := range []struct {
		name    string
		engine  string
		version string
		suffix  string
	}{
		{"name_and_version", "engine", "1.2.3", " | engine=1.2.3"},
		{"name_only", "engine", "", ""},
		{"version_only", "", "1.2.3", ""},
		{"neither", "", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			PrintExitFooter(&buf, caps, "wrap", ExitFooter{
				AuthStatus: "ok", EngineName: tc.engine, EngineVersion: tc.version,
			})
			want := "wrap | exit=0 | duration=<1s | auth=ok" + tc.suffix + "\n"
			if got := buf.String(); got != want {
				t.Fatalf("plain footer = %q, want %q", got, want)
			}
		})
	}
}

func TestExitFooterFallsBackToTheWrapperPrefix(t *testing.T) {
	caps := footerCaps(80)
	var rich bytes.Buffer
	PrintExitFooter(&rich, caps, "", ExitFooter{})
	if !strings.Contains(StripANSI(rich.String()), "WRAPPER") {
		t.Fatalf("rich footer lost the prefix fallback:\n%q", rich.String())
	}

	plainCaps := caps
	plainCaps.IsTTY = false
	var plain bytes.Buffer
	PrintExitFooter(&plain, plainCaps, "  ", ExitFooter{AuthStatus: "ok"})
	if got, want := plain.String(), "wrapper | exit=0 | duration=<1s | auth=ok\n"; got != want {
		t.Fatalf("plain footer = %q, want %q", got, want)
	}
}

func TestExitFooterIgnoresANilWriter(t *testing.T) {
	// A missing destination must never take the process down on the exit path.
	PrintExitFooter(nil, footerCaps(80), "wrap", ExitFooter{ExitCode: 1, AuthTone: ToneFail})
}

func TestDurationPrecise(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   time.Duration
		want string
	}{
		{"negative", -90 * time.Second, "<1s"},
		{"zero", 0, "<1s"},
		{"rounds_down_below_a_second", 400 * time.Millisecond, "<1s"},
		{"rounds_up_to_a_second", 1400 * time.Millisecond, "1s"},
		{"exact_second", time.Second, "1s"},
		{"exact_minute", time.Minute, "1m"},
		{"minutes_and_seconds", 90 * time.Second, "1m 30s"},
		{"hours_skip_empty_minutes", time.Hour + 5*time.Second, "1h 5s"},
		{"hours_minutes_seconds", 2*time.Hour + 3*time.Minute + 4*time.Second, "2h 3m 4s"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := durationPrecise(tc.in); got != tc.want {
				t.Fatalf("durationPrecise(%s) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// footerCaps is a rich terminal with colour enabled, so tone selection is
// observable in the rendered escape sequences.
func footerCaps(columns int) Caps {
	caps := screenCaps(columns)
	caps.NoColor = false
	caps.Palette = Palette{
		Bold: "\x1b[1m", Dim: "\x1b[2m", Reset: "\x1b[0m",
		Green: "\x1b[32m", Orange: "\x1b[38;5;208m", Red: "\x1b[31m",
	}
	return caps
}

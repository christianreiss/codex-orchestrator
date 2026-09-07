package terminalui

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

func TestEngineIdentityChangesOnlyAccentAndPrefix(t *testing.T) {
	caps := screenCaps(90)
	caps.NoColor = false
	caps.Palette = Palette{Bold: "\x1b[1m", Dim: "\x1b[2m", Reset: "\x1b[0m", Orange: "\x1b[38;5;208m", Pink: "\x1b[38;5;205m", Violet: "\x1b[38;5;141m"}
	for _, tone := range []Tone{ToneOK, ToneWarn, ToneFail, ToneDim} {
		var codex, claude bytes.Buffer
		in := ScreenInput{Prefix: "cdx", EngineName: "agent", EngineVersion: "1.0.0", WrapperVersion: "0.8.0", Model: "shared-model", Effort: "high", Dots: []HealthDot{{Name: "auth", Tone: tone}}, ResultTone: tone, ResultLabel: "Measured session state.", QuotaRows: []QuotaRow{{Label: "weekly", Used: 73, ResetAfter: time.Hour}}}
		printBootScreen(&codex, in, caps)
		in.Prefix = "clx"
		printBootScreen(&claude, in, caps)
		if got, want := strings.ReplaceAll(StripANSI(codex.String()), "CDX", "CLX"), StripANSI(claude.String()); got != want {
			t.Fatalf("engine-specific layout drift for %s:\n%s\n%s", tone, got, want)
		}
		if !strings.Contains(codex.String(), caps.Palette.Orange) || !strings.Contains(claude.String(), caps.Palette.Violet) {
			t.Fatal("engine accent missing")
		}
	}
}

func TestStaleQuotaIsDimAndExplicitInBothOutputModes(t *testing.T) {
	caps := screenCaps(80)
	caps.Palette = Palette{Dim: "\x1b[2m", Reset: "\x1b[0m", Bold: "\x1b[1m", Orange: "\x1b[33m", Red: "\x1b[31m", Green: "\x1b[32m"}
	row := QuotaRow{Label: "weekly", Used: 99, Stale: true}
	rich := strings.Join(formatQuotaLines(caps, row, 70), "\n")
	if strings.Contains(rich, caps.Palette.Red) || strings.Contains(rich, caps.Palette.Green) || strings.Contains(rich, caps.Palette.Orange) {
		t.Fatalf("stale usage received a current-status color: %q", rich)
	}
	if !strings.Contains(StripANSI(rich), "last reported") || !strings.Contains(rich, caps.Palette.Dim) {
		t.Fatal("stale quota is not explicitly marked")
	}
	var plain bytes.Buffer
	printMinimalScreen(&plain, ScreenInput{QuotaRows: []QuotaRow{row}}, caps)
	if !strings.Contains(plain.String(), "stale=true") {
		t.Fatalf("plain output hides stale quota: %s", plain.String())
	}
}

func TestConcurrentFailureRemainsBlocked(t *testing.T) {
	var out bytes.Buffer
	printBootScreen(&out, ScreenInput{Concurrent: true, ResultTone: ToneFail, ResultLabel: "Authentication was rejected."}, screenCaps(80))
	if !strings.Contains(out.String(), "BLOCKED") || strings.Contains(out.String(), "SYNC PAUSED") {
		t.Fatalf("concurrent marker hid refusal: %s", out.String())
	}
}

func TestSkipBannerForcesSafeMinimalOutputOnRichTerminal(t *testing.T) {
	var out bytes.Buffer
	printBootScreen(&out, ScreenInput{SkipBanner: true, EngineVersion: "1.0.0", ResultLabel: "Ready."}, screenCaps(80))
	if !strings.Contains(out.String(), "codex=1.0.0") || strings.ContainsAny(out.String(), "╭╯\x1b") {
		t.Fatalf("skip banner retained rich decoration: %q", out.String())
	}
}

func TestStandardStartupWithFourQuotaWindowsFitsOneScreen(t *testing.T) {
	in := ScreenInput{
		Model: "gpt-6-astra", Effort: "high", HostFQDN: "workstation.example",
		EngineVersion: "0.144.1", WrapperVersion: "0.8.0", ResultLabel: "Ready to launch.",
		Dots: []HealthDot{{Name: "api"}, {Name: "auth"}, {Name: "runner"}, {Name: "agents"}, {Name: "config"}, {Name: "skills"}},
		QuotaRows: []QuotaRow{
			{Label: "5h", Used: 32, ResetAfter: 2 * time.Hour},
			{Label: "weekly", Used: 45, ResetAfter: 4 * 24 * time.Hour},
			{Label: "⚡ 5h", Used: 12, ResetAfter: 3 * time.Hour},
			{Label: "⚡ weekly", Used: 21, ResetAfter: 5 * 24 * time.Hour},
		},
		SessionRows: []SessionRow{{Label: "local procs", Count: 1}, {Label: "hosts 30m", Count: 8}, {Label: "syncs UTC day", Count: 143}},
	}
	var out bytes.Buffer
	printBootScreen(&out, in, screenCaps(80))
	if lines := strings.Count(out.String(), "\n"); lines > 24 {
		t.Fatalf("standard startup exceeded 24 terminal rows (%d):\n%s", lines, out.String())
	}
}

func TestQuotaWindowLabelsRemainCompleteAcrossWidths(t *testing.T) {
	for _, width := range []int{34, 42, 74} {
		caps := screenCaps(width + 6)
		lines := formatQuotaLines(caps, QuotaRow{Label: "⚡ weekly", Used: 21, ResetAfter: 5 * 24 * time.Hour}, width)
		if !strings.Contains(strings.Join(lines, "\n"), "⚡ weekly") {
			t.Fatalf("quota window label was clipped at %d columns: %q", width, lines)
		}
		for _, line := range lines {
			if VisibleWidth(line) > width {
				t.Fatalf("quota row exceeded %d columns: %q", width, line)
			}
		}
	}
}

type writeCounter struct{ calls int }

func (w *writeCounter) Write(p []byte) (int, error) { w.calls++; return len(p), nil }

func TestRichFramesUseOneDestinationWrite(t *testing.T) {
	caps := screenCaps(80)
	for _, scene := range []struct {
		name   string
		render func(io.Writer)
	}{
		{"screen", func(w io.Writer) {
			printBootScreen(w, ScreenInput{Dots: []HealthDot{{Name: "auth", Tone: ToneOK}}, ResultLabel: "Ready."}, caps)
		}},
		{"doctor", func(w io.Writer) {
			PrintDoctor(w, caps, DoctorReport{Engine: "cdx", Rows: []DoctorRow{{Label: "auth", Tone: ToneOK, Value: "usable"}}})
		}},
		{"footer", func(w io.Writer) { PrintExitFooter(w, caps, "clx", ExitFooter{}) }},
		{"help", func(w io.Writer) {
			PrintWrapperHelp(w, caps, "cdx", "Codex", []HelpItem{{Usage: "cdx sync", Description: "Synchronize managed files."}}, nil)
		}},
		{"approval", func(w io.Writer) { drawApprovalBox(w, caps, approvalBoxData{Status: "insecure"}) }},
	} {
		t.Run(scene.name, func(t *testing.T) {
			counter := &writeCounter{}
			scene.render(counter)
			if counter.calls != 1 {
				t.Fatalf("%s emitted %d writes, want one complete frame", scene.name, counter.calls)
			}
		})
	}
}

func BenchmarkFrameWrites(b *testing.B) {
	for _, buffered := range []bool{false, true} {
		b.Run(fmt.Sprint("buffered=", buffered), func(b *testing.B) {
			b.ReportAllocs()
			counter := &writeCounter{}
			for i := 0; i < b.N; i++ {
				c := newCard(counter, screenCaps(80))
				if buffered {
					c = newFrame(counter, screenCaps(80))
				}
				c.top()
				for j := 0; j < 18; j++ {
					c.line("A complete, measured status line.")
				}
				c.bottom()
			}
			b.ReportMetric(float64(counter.calls)/float64(b.N), "writes/frame")
		})
	}
}

func BenchmarkBootScreen(b *testing.B) {
	b.ReportAllocs()
	in := ScreenInput{Prefix: "cdx", EngineName: "codex", EngineVersion: "0.144.1", WrapperVersion: "0.8.0", HostFQDN: "workstation.example", Model: "gpt-6-astra", Effort: "high", Dots: []HealthDot{{Name: "api", Tone: ToneOK}, {Name: "auth", Tone: ToneOK}, {Name: "config", Tone: ToneOK}}, QuotaRows: []QuotaRow{{Label: "5h", Used: 42}}, ResultLabel: "Ready to launch."}
	for i := 0; i < b.N; i++ {
		printBootScreen(io.Discard, in, screenCaps(80))
	}
}

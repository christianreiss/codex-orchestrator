package ui

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestPrintBootScreenRichIsAtAGlanceAndResponsive(t *testing.T) {
	caps := screenCaps(72)
	var buf bytes.Buffer
	printBootScreen(&buf, ScreenInput{
		WrapperVersion: "0.6.44", WrapperTarget: "0.6.45", WrapperTone: ToneWarn,
		ClaudeVersion: "2.1.206", ClaudeTone: ToneOK,
		HostFQDN: "workstation.example", Model: "claude-sonnet-5", Effort: "high", APICalls: 12345,
		Dots: []HealthDot{
			{Name: "api", Tone: ToneOK},
			{Name: "auth", Tone: ToneWarn},
			{Name: "runner", Tone: ToneFail},
		},
		SessionRows:       []SessionRow{{Label: "local procs", Count: 2}, {Label: "syncs UTC month", Count: 1234}},
		BypassPermissions: true,
		ResultLabel:       "Ready with warnings; run `clx doctor` for details.", ResultTone: ToneWarn,
	}, caps)
	out := buf.String()
	for _, want := range []string{
		"CLX", "CODEX ORCHESTRATOR", "ATTENTION", "workstation.example",
		"claude-sonnet-5/high", "claude 2.1.206", "wrapper 0.6.44", "→ 0.6.45",
		"api", "auth", "runner", "ACTIVITY", "local procs", "1,234", "SECURITY", "Bypass permissions active",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("rich screen missing %q:\n%s", want, out)
		}
	}
	for _, shape := range []string{"✓", "!", "×"} {
		if !strings.Contains(out, shape) {
			t.Fatalf("NO_COLOR semantics missing %q:\n%s", shape, out)
		}
	}
	assertScreenLinesFit(t, out, caps.Columns)
}

func TestPrintBootScreenSanitizesDynamicValues(t *testing.T) {
	caps := screenCaps(48)
	var buf bytes.Buffer
	printBootScreen(&buf, ScreenInput{
		HostFQDN:       "node\x1b]2;FORGED\a.example\nsecond-row",
		ClaudeVersion:  "2.1.206\x1b[2J",
		WrapperVersion: "0.6.44",
		ResultLabel:    strings.Repeat("long result ", 20),
	}, caps)
	out := buf.String()
	if strings.Contains(out, "\x1b") || strings.Contains(out, "FORGED") || strings.Contains(out, "second-row\n") {
		t.Fatalf("terminal controls or forged rows survived sanitization: %q", out)
	}
	assertScreenLinesFit(t, out, caps.Columns)
}

func TestPrintMinimalScreenIsStableAndLogSafe(t *testing.T) {
	var buf bytes.Buffer
	PrintBootScreen(&buf, ScreenInput{
		WrapperVersion: "0.6.44", ClaudeVersion: "2.1.206", HostFQDN: "host.example",
		Dots: []HealthDot{{Name: "api", Tone: ToneOK}}, BypassPermissions: true,
		SessionRows: []SessionRow{{Label: "hosts 30m", Count: 7}, {Label: "syncs UTC day", Count: 21}},
		ResultLabel: "Ready.",
	})
	out := buf.String()
	for _, want := range []string{
		"clx | status=attention", "host=host.example", "claude=2.1.206", "wrapper=0.6.44",
		"health | api=ok", "activity | hosts 30m=7 | syncs UTC day=21", "warning | bypass permissions active (--dangerously-skip-permissions)", "result | Ready.",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("minimal screen missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "\x1b[") {
		t.Fatalf("minimal screen contains ANSI: %q", out)
	}
}

func TestScreenKeepsEffortVisibleWithoutModel(t *testing.T) {
	var rich bytes.Buffer
	printBootScreen(&rich, ScreenInput{Effort: "high"}, screenCaps(64))
	if !strings.Contains(StripANSI(rich.String()), "effort high") {
		t.Fatalf("rich screen hid effort-only context:\n%s", rich.String())
	}

	var minimal bytes.Buffer
	PrintMinimalScreen(&minimal, ScreenInput{Effort: "high"})
	if !strings.Contains(minimal.String(), "effort=high") {
		t.Fatalf("minimal screen hid effort-only context:\n%s", minimal.String())
	}
}

func TestCompactScreenAndFooterRespectDetectedWidths(t *testing.T) {
	for _, width := range []int{39, 80} {
		t.Run(fmt.Sprintf("width_%d", width), func(t *testing.T) {
			caps := screenCaps(width)
			caps.IsTTY = false
			caps.Palette = Palette{Bold: "\x1b[1m", Reset: "\x1b[0m", Red: "\x1b[31m"}
			input := ScreenInput{
				HostFQDN:      strings.Repeat("very-long-host-", 8) + "é.example",
				ClaudeVersion: strings.Repeat("2.1.206-long-", 5), WrapperVersion: "0.6.44",
				Model: strings.Repeat("claude-ultra-long-", 6), Effort: "high",
				Dots:        []HealthDot{{Name: strings.Repeat("runner-long-", 6), Tone: ToneFail}},
				ResultLabel: strings.Repeat("sync failed with a detailed reason ", 12), ResultTone: ToneFail,
			}
			var screen bytes.Buffer
			printMinimalScreen(&screen, input, caps)
			assertScreenLinesFit(t, screen.String(), width)
			assertASCIIOutput(t, screen.String())

			var footer bytes.Buffer
			PrintExitFooter(&footer, caps, "clx", ExitFooter{
				ExitCode: 7, AuthTone: ToneFail,
				AuthStatus: strings.Repeat("credential upload failed ", 8) + "é",
				EngineName: "claude", EngineVersion: strings.Repeat("2.1.206-long-", 6),
			})
			assertScreenLinesFit(t, footer.String(), width)
			assertASCIIOutput(t, footer.String())
			if !strings.Contains(footer.String(), "exit=7") || !strings.Contains(footer.String(), "auth=") {
				t.Fatalf("compact footer lost measured outcome:\n%s", footer.String())
			}
		})
	}
}

func TestRichConcurrentScreenKeepsHealthAtAGlance(t *testing.T) {
	caps := screenCaps(64)
	var buf bytes.Buffer
	printBootScreen(&buf, ScreenInput{
		Concurrent: true, ConcurrentNote: "Managed content sync paused; auth freshness remains active.",
		Dots:        []HealthDot{{Name: "api", Tone: ToneOK}, {Name: "auth", Tone: ToneWarn}},
		ResultLabel: "Managed content sync paused; auth freshness remains active.",
	}, caps)
	for _, want := range []string{"SYNC PAUSED", "auth freshness remains", "active.", "api", "auth"} {
		if !strings.Contains(buf.String(), want) {
			t.Fatalf("concurrent screen missing %q:\n%s", want, buf.String())
		}
	}
}

func TestResultLabelIsBoundedWithoutHidingNormalErrors(t *testing.T) {
	caps := screenCaps(40)
	var long bytes.Buffer
	renderToneTextLimited(newCard(&long, caps), ToneFail, strings.Repeat("detailed failure reason ", 20), 3)
	lines := strings.Split(strings.TrimSuffix(long.String(), "\n"), "\n")
	if len(lines) != 3 || !strings.Contains(lines[2], "…") {
		t.Fatalf("long result should be three lines with ellipsis, got %d:\n%s", len(lines), long.String())
	}

	var normal bytes.Buffer
	renderToneTextLimited(newCard(&normal, caps), ToneFail, "API error: connection refused", 3)
	if !strings.Contains(normal.String(), "API error: connection refused") || strings.Contains(normal.String(), "…") {
		t.Fatalf("normal error was hidden or truncated:\n%s", normal.String())
	}

	plainCaps := caps
	plainCaps.IsTTY = false
	plainCaps.Columns = 39
	var plain bytes.Buffer
	printPlainLineLimited(&plain, plainCaps, "result | "+strings.Repeat("detailed failure reason ", 20), 3)
	plainLines := strings.Split(strings.TrimSuffix(plain.String(), "\n"), "\n")
	if len(plainLines) != 3 || !strings.HasSuffix(plainLines[2], "...") {
		t.Fatalf("compact result should be three ASCII lines with ellipsis, got %d:\n%s", len(plainLines), plain.String())
	}
}

func TestBypassPermissionsUsesWarningSemantics(t *testing.T) {
	caps := screenCaps(64)
	var buf bytes.Buffer
	printBootScreen(&buf, ScreenInput{BypassPermissions: true, ResultLabel: "Ready with warning."}, caps)
	plain := StripANSI(buf.String())
	if !strings.Contains(plain, "! Bypass permissions active") {
		t.Fatalf("bypass warning marker missing:\n%s", plain)
	}
	if strings.Contains(plain, "× Bypass permissions active") {
		t.Fatalf("bypass advisory rendered as failure:\n%s", plain)
	}
}

func TestPrintMinimalScreenShowsTargetsAndUsesPortableASCII(t *testing.T) {
	var buf bytes.Buffer
	PrintMinimalScreen(&buf, ScreenInput{
		ClaudeVersion: "2.1.206", ClaudeTarget: "2.1.207",
		WrapperVersion: "0.6.44", WrapperTarget: "0.6.45",
		ResultLabel: "Ready — update available…", ResultTone: ToneWarn,
	})
	out := buf.String()
	for _, want := range []string{"claude=2.1.206->2.1.207", "wrapper=0.6.44->0.6.45", "Ready - update available..."} {
		if !strings.Contains(out, want) {
			t.Fatalf("compact output missing %q:\n%s", want, out)
		}
	}
	if strings.ContainsAny(out, "—…→") {
		t.Fatalf("compact output contains non-portable glyphs: %q", out)
	}
}

func TestExitFooterReportsMeasuredFailure(t *testing.T) {
	caps := screenCaps(64)
	var rich bytes.Buffer
	PrintExitFooter(&rich, caps, "clx", ExitFooter{
		RunDuration: 2*time.Minute + 7*time.Second,
		ExitCode:    7, AuthStatus: "upload failed", AuthTone: ToneFail,
		EngineName: "claude", EngineVersion: "2.1.206",
	})
	for _, want := range []string{"CLX", "EXIT 7", "2m 7s", "upload failed", "claude", "2.1.206", "×"} {
		if !strings.Contains(rich.String(), want) {
			t.Fatalf("rich footer missing %q:\n%s", want, rich.String())
		}
	}
	assertScreenLinesFit(t, rich.String(), caps.Columns)

	plainCaps := caps
	plainCaps.IsTTY = false
	var plain bytes.Buffer
	PrintExitFooter(&plain, plainCaps, "clx", ExitFooter{ExitCode: 7, AuthStatus: "upload failed"})
	if got := plain.String(); got != "clx | exit=7 | duration=<1s | auth=upload failed\n" {
		t.Fatalf("plain footer = %q", got)
	}
}

func TestExitFooterEscalatesAuthFailureWithSuccessfulProcess(t *testing.T) {
	caps := screenCaps(64)
	var buf bytes.Buffer
	PrintExitFooter(&buf, caps, "clx", ExitFooter{ExitCode: 0, AuthStatus: "upload failed", AuthTone: ToneFail})
	if !strings.Contains(buf.String(), "EXIT 0") || !strings.Contains(buf.String(), "AUTH FAILED") {
		t.Fatalf("auth failure was hidden by exit zero:\n%s", buf.String())
	}
}

func TestTerminalSanitizerRemovesCSIAndOSC(t *testing.T) {
	got := CleanInline("safe\x1b[31m red\x1b[0m \x1b]8;;https://evil.invalid\aowned\x1b]8;;\a text")
	if got != "safe red owned text" {
		t.Fatalf("CleanInline = %q", got)
	}
}

func TestDetectCapsForGenericWriterIsRedirected(t *testing.T) {
	var buf bytes.Buffer
	if caps := DetectCapsFor(&buf, "auto"); caps.IsTTY || caps.Palette.Reset != "" {
		t.Fatalf("generic writer inherited terminal capabilities: %+v", caps)
	}
}

func TestHealthAndQuotaPrimitives(t *testing.T) {
	caps := screenCaps(80)
	var buf bytes.Buffer
	PrintHealthRow(&buf, caps, []HealthDot{{Name: "api", Tone: ToneOK}, {Name: "auth", Tone: ToneWarn, Updated: true}})
	if !strings.Contains(buf.String(), "api") || !strings.Contains(buf.String(), "auth") || !strings.Contains(buf.String(), "↑") {
		t.Fatalf("health row missing state: %q", buf.String())
	}
	for pct, wantEmpty := range map[int]bool{0: true, 50: true, 100: false} {
		bar := BuildBar(caps, pct)
		if strings.Contains(bar, caps.BannerSym.BarEmpty) != wantEmpty {
			t.Fatalf("bar %d%% = %q", pct, bar)
		}
	}
}

func screenCaps(columns int) Caps {
	return Caps{
		IsTTY: true, NoColor: true, UTF8: true, Columns: columns, Theme: ThemeViolet,
		BannerSym: BannerGlyphs{
			BoxTL: "╭", BoxTR: "╮", BoxBL: "╰", BoxBR: "╯", BoxH: "─", BoxV: "│",
			BarFill: "█", BarEmpty: "░",
		},
	}
}

func assertScreenLinesFit(t *testing.T, output string, columns int) {
	t.Helper()
	for i, line := range strings.Split(strings.TrimSuffix(output, "\n"), "\n") {
		if got := VisibleWidth(line); got > columns {
			t.Fatalf("line %d is %d columns wide, cap is %d: %q", i+1, got, columns, line)
		}
	}
}

func assertASCIIOutput(t *testing.T, output string) {
	t.Helper()
	if strings.Contains(output, "\x1b") {
		t.Fatalf("compact output contains ANSI: %q", output)
	}
	for _, r := range output {
		if r > 0x7f {
			t.Fatalf("compact output contains non-ASCII rune %q: %q", r, output)
		}
	}
}

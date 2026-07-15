package ui

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestPrintBootScreenRichIsAtAGlanceAndResponsive(t *testing.T) {
	caps := screenCaps(72)
	in := ScreenInput{
		WrapperVersion: "0.6.44", WrapperTarget: "0.6.45", WrapperTone: ToneWarn,
		CodexVersion: "0.144.1", CodexTone: ToneOK,
		HostFQDN: "workstation.example", Model: "gpt-5.6-terra", Effort: "ultra",
		Lane: "normal", BrowserOS: true, APICalls: 12345,
		Dots: []HealthDot{
			{Name: "api", Tone: ToneOK},
			{Name: "auth", Tone: ToneWarn},
			{Name: "runner", Tone: ToneFail},
		},
		QuotaRows:   []QuotaRow{{Label: "5h", Used: 73, ResetAfter: 42 * time.Minute}},
		SessionRows: []SessionRow{{Label: "month", Count: 1234}},
		ResultLabel: "Ready with warnings; run `cdx doctor` for details.", ResultTone: ToneWarn,
	}

	var buf bytes.Buffer
	printBootScreen(&buf, in, caps)
	out := buf.String()
	for _, want := range []string{
		"CDX", "CODEX ORCHESTRATOR", "ATTENTION", "workstation.example",
		"gpt-5.6-terra/ultra", "BrowserOS", "codex 0.144.1", "wrapper 0.6.44",
		"→ 0.6.45", "api", "auth", "runner", "QUOTA", "73%", "SESSIONS", "1,234",
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
		CodexVersion:   "1.2.3\x1b[2J",
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
		WrapperVersion: "0.6.44", CodexVersion: "0.144.1", BrowserOS: true,
		HostFQDN: "host.example", Dots: []HealthDot{{Name: "api", Tone: ToneOK}},
		ResultLabel: "Ready.",
	})
	out := buf.String()
	for _, want := range []string{
		"cdx | status=ready | host=host.example | codex=0.144.1 | wrapper=0.6.44 | browseros=enabled",
		"health | api=ok", "result | Ready.",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("minimal screen missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "\x1b[") {
		t.Fatalf("minimal screen contains ANSI: %q", out)
	}
}

func TestPrintMinimalScreenShowsTargetsAndUsesPortableASCII(t *testing.T) {
	var buf bytes.Buffer
	PrintMinimalScreen(&buf, ScreenInput{
		CodexVersion: "0.144.1", CodexTarget: "0.145.0",
		WrapperVersion: "0.6.44", WrapperTarget: "0.6.45",
		QuotaRows:   []QuotaRow{{Label: "⚡ 5h", Used: 80}},
		ResultLabel: "Ready — update available…", ResultTone: ToneWarn,
	})
	out := buf.String()
	for _, want := range []string{"codex=0.144.1->0.145.0", "wrapper=0.6.44->0.6.45", "quota | spark 5h=80%", "Ready - update available..."} {
		if !strings.Contains(out, want) {
			t.Fatalf("compact output missing %q:\n%s", want, out)
		}
	}
	if strings.ContainsAny(out, "⚡—…→") {
		t.Fatalf("compact output contains non-portable glyphs: %q", out)
	}
}

func TestExitFooterReportsMeasuredFailure(t *testing.T) {
	caps := screenCaps(64)
	var rich bytes.Buffer
	PrintExitFooter(&rich, caps, "cdx", ExitFooter{
		RunDuration: 2*time.Minute + 7*time.Second,
		ExitCode:    7, AuthStatus: "upload failed", AuthTone: ToneFail,
		EngineName: "codex", EngineVersion: "0.144.1",
	})
	for _, want := range []string{"CDX", "EXIT 7", "2m 7s", "upload failed", "codex", "0.144.1", "×"} {
		if !strings.Contains(rich.String(), want) {
			t.Fatalf("rich footer missing %q:\n%s", want, rich.String())
		}
	}
	assertScreenLinesFit(t, rich.String(), caps.Columns)

	plainCaps := caps
	plainCaps.IsTTY = false
	var plain bytes.Buffer
	PrintExitFooter(&plain, plainCaps, "cdx", ExitFooter{ExitCode: 7, AuthStatus: "upload failed"})
	if got := plain.String(); got != "cdx | exit=7 | duration=<1s | auth=upload failed\n" {
		t.Fatalf("plain footer = %q", got)
	}
}

func TestExitFooterEscalatesAuthFailureWithSuccessfulProcess(t *testing.T) {
	caps := screenCaps(64)
	var buf bytes.Buffer
	PrintExitFooter(&buf, caps, "cdx", ExitFooter{ExitCode: 0, AuthStatus: "upload failed", AuthTone: ToneFail})
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
		IsTTY: true, NoColor: true, UTF8: true, Columns: columns, Theme: ThemeOrange,
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

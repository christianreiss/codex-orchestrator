package ui

import (
	"bytes"
	"strings"
	"testing"
)

func TestPrintBootDrawsArt(t *testing.T) {
	var buf bytes.Buffer
	caps := DetectCaps("auto")
	// Force narrow stacking path so we don't depend on TTY caps.
	caps.Columns = 40
	caps.Palette = Palette{} // no ANSI for stable assertions
	PrintBoot(&buf, caps, BannerInfo{
		Title:       "codex orchestrator",
		Tagline:     "Codex to Brrr!",
		CodexLine:   "codex    1.2.3",
		WrapperLine: "wrapper  4.5.6",
		ContextLine: "normal",
	})
	out := buf.String()
	if !strings.Contains(out, "██████╗") {
		t.Errorf("expected art glyphs in output; got:\n%s", out)
	}
	if !strings.Contains(out, "codex orchestrator") {
		t.Errorf("expected title; got:\n%s", out)
	}
	if !strings.Contains(out, "wrapper  4.5.6") {
		t.Errorf("expected wrapper line; got:\n%s", out)
	}
}

func TestPrintHealthRow(t *testing.T) {
	var buf bytes.Buffer
	caps := DetectCaps("")
	caps.Palette = Palette{}
	PrintHealthRow(&buf, caps, []HealthDot{
		{Name: "api", Tone: ToneOK},
		{Name: "auth", Tone: ToneWarn, Updated: true},
		{Name: "", Tone: ToneFail}, // should be skipped
	})
	out := buf.String()
	if !strings.Contains(out, "api") || !strings.Contains(out, "auth") {
		t.Errorf("expected dots in output; got: %q", out)
	}
}

func TestPrintQuotaRow(t *testing.T) {
	var buf bytes.Buffer
	caps := DetectCaps("")
	caps.Palette = Palette{}
	PrintQuotaRow(&buf, caps, QuotaRow{
		Label:      "5h     ",
		Used:       50,
		BlockAtPct: 100,
		WarnAtPct:  80,
	})
	out := buf.String()
	if !strings.Contains(out, "5h") {
		t.Errorf("expected label in output; got: %q", out)
	}
	if !strings.Contains(out, "50%") {
		t.Errorf("expected percent; got: %q", out)
	}
}

func TestBuildBarFillsProportionally(t *testing.T) {
	caps := DetectCaps("")
	caps.Palette = Palette{}
	bar0 := BuildBar(caps, 0)
	bar50 := BuildBar(caps, 50)
	bar100 := BuildBar(caps, 100)
	if !strings.Contains(bar0, "░") {
		t.Errorf("0%% bar should be empty: %q", bar0)
	}
	if !strings.Contains(bar50, "█") && !strings.Contains(bar50, "░") {
		t.Errorf("50%% bar should have both fills: %q", bar50)
	}
	if strings.Contains(bar100, "░") {
		t.Errorf("100%% bar should not have empty chars: %q", bar100)
	}
}

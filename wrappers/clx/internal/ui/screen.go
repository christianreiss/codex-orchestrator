package ui

import (
	"fmt"
	"io"
	"strings"
)

// ScreenInput drives the clx boot/status screen. No lane or quota bars —
// Claude has neither in this orchestrator.
type ScreenInput struct {
	WrapperVersion string
	WrapperTone    Tone
	WrapperTarget  string

	ClaudeVersion string
	ClaudeTone    Tone
	ClaudeTarget  string

	HostFQDN string
	Insecure bool
	Model    string

	APICalls int64

	Concurrent     bool
	ConcurrentNote string

	Dots []HealthDot

	ResultLabel string
	ResultTone  Tone

	Theme string
}

// PrintBootScreen draws the entire boot/status screen on stderr.
func PrintBootScreen(w io.Writer, in ScreenInput) {
	caps := DetectCaps(in.Theme)
	tone := in.WrapperTone
	if tone == "" {
		tone = ToneOK
	}

	claudeLine := fmt.Sprintf("claude   %s", strOr(in.ClaudeVersion, "—"))
	if in.ClaudeTarget != "" && in.ClaudeTone != ToneOK {
		claudeLine += "  " + caps.Palette.Yellow + "→ " + in.ClaudeTarget + caps.Palette.Reset
	}
	wrapperLine := fmt.Sprintf("wrapper  %s", strOr(in.WrapperVersion, "—"))
	if in.WrapperTarget != "" && in.WrapperTone != ToneOK {
		wrapperLine += "  " + caps.Palette.Yellow + "→ " + in.WrapperTarget + caps.Palette.Reset
	}

	ctxParts := []string{}
	if in.Insecure {
		ctxParts = append(ctxParts, caps.Palette.Yellow+"🔓 insecure"+caps.Palette.Reset)
	}
	if in.Concurrent {
		ctxParts = append(ctxParts, caps.Palette.Yellow+"concurrent run"+caps.Palette.Reset)
	}
	if in.Model != "" {
		ctxParts = append(ctxParts, in.Model)
	}
	if in.APICalls > 0 {
		ctxParts = append(ctxParts, fmt.Sprintf("%s calls", CompactNumber(in.APICalls)))
	}
	contextLine := strings.Join(ctxParts, "  ·  ")

	PrintBoot(w, caps, BannerInfo{
		Title:       "claude orchestrator",
		Tagline:     "Claude go brrrr!",
		ClaudeLine:  claudeLine,
		WrapperLine: wrapperLine,
		ContextLine: contextLine,
		Tone:        string(tone),
	})

	fmt.Fprintln(w)
	if in.Concurrent {
		PrintConcurrentRow(w, caps, in.ConcurrentNote)
	} else if len(in.Dots) > 0 {
		PrintHealthRow(w, caps, in.Dots)
	}

	if in.ResultLabel != "" {
		fmt.Fprintln(w)
		PrintResult(w, caps, in.ResultLabel, in.ResultTone)
	}
}

func PrintMinimalScreen(w io.Writer, in ScreenInput) {
	parts := []string{}
	for _, d := range in.Dots {
		t := "green"
		switch d.Tone {
		case ToneWarn:
			t = "yellow"
		case ToneFail:
			t = "red"
		}
		parts = append(parts, fmt.Sprintf("%s=%s", d.Name, t))
	}
	fmt.Fprintln(w, "Health  | "+strings.Join(parts, " "))
	if in.ResultLabel != "" {
		fmt.Fprintln(w, "Result  | "+in.ResultLabel)
	}
}

func strOr(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

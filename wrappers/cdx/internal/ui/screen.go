package ui

import (
	"fmt"
	"io"
	"strings"
	"time"
)

// ScreenInput is everything the renderer needs to draw the boot/status screen.
// All fields are optional — missing data degrades gracefully.
type ScreenInput struct {
	WrapperVersion string
	WrapperTone    Tone   // green=current, yellow=update available, red=missing
	WrapperTarget  string // shown next to wrapper line when not green

	CodexVersion string
	CodexTone    Tone
	CodexTarget  string

	HostFQDN string
	Insecure bool

	Lane     string // "normal" | "spark" | ""
	TokenSum int64  // current month total tokens — shown in compact format
	APICalls int64  // shown if TokenSum is 0

	Concurrent     bool
	ConcurrentNote string

	Dots []HealthDot

	QuotaRows  []QuotaRow
	QuotaWarn  string // ⚠ row text (empty to skip)
	QuotaBlock string // ⛔ row text (empty to skip)

	// SessionRows renders a label/count block under the quota bars (see
	// PrintSessionsBlock). Empty/nil → block is skipped entirely.
	SessionRows []SessionRow

	ResultLabel string
	ResultTone  Tone

	Theme string
}

// SessionRow is one entry in the "sessions" block. Label is shown left-padded
// to align with siblings; Count is rendered with thousands separators via
// GroupedInt.
type SessionRow struct {
	Label string
	Count int64
}

// PrintBootScreen draws the entire boot/status screen on stderr.
func PrintBootScreen(w io.Writer, in ScreenInput) {
	caps := DetectCaps(in.Theme)
	tone := in.WrapperTone
	if tone == "" {
		tone = ToneOK
	}

	codexLine := fmt.Sprintf("codex    %s", strOr(in.CodexVersion, "—"))
	if in.CodexTarget != "" && in.CodexTone != ToneOK {
		codexLine += "  " + caps.Palette.Yellow + "→ " + in.CodexTarget + caps.Palette.Reset
	}
	wrapperLine := fmt.Sprintf("wrapper  %s", strOr(in.WrapperVersion, "—"))
	if in.WrapperTarget != "" && in.WrapperTone != ToneOK {
		wrapperLine += "  " + caps.Palette.Yellow + "→ " + in.WrapperTarget + caps.Palette.Reset
	}

	// Context line: insecure · lane · tokens
	ctxParts := []string{}
	if in.Insecure {
		ctxParts = append(ctxParts, caps.Palette.Yellow+"🔓 insecure"+caps.Palette.Reset)
	}
	if in.Concurrent {
		ctxParts = append(ctxParts, caps.Palette.Yellow+"concurrent run"+caps.Palette.Reset)
	}
	if in.Lane != "" {
		laneTxt := in.Lane
		if in.Lane == "spark" {
			laneTxt = caps.BannerSym.IconSpark + " spark"
		}
		ctxParts = append(ctxParts, laneTxt)
	}
	switch {
	case in.TokenSum > 0:
		ctxParts = append(ctxParts, fmt.Sprintf("%s tokens", CompactNumber(in.TokenSum)))
	case in.APICalls > 0:
		ctxParts = append(ctxParts, fmt.Sprintf("%s calls", CompactNumber(in.APICalls)))
	}
	contextLine := strings.Join(ctxParts, "  ·  ")

	PrintBoot(w, caps, BannerInfo{
		Title:       "codex orchestrator",
		Tagline:     "Codex to Brrr!",
		CodexLine:   codexLine,
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

	if len(in.QuotaRows) > 0 {
		fmt.Fprintln(w)
		for _, q := range in.QuotaRows {
			PrintQuotaRow(w, caps, q)
		}
	}
	if in.QuotaWarn != "" {
		PrintQuotaReason(w, caps, "", in.QuotaWarn, ToneWarn)
	}
	if in.QuotaBlock != "" {
		PrintQuotaReason(w, caps, "", in.QuotaBlock, ToneFail)
	}

	if len(in.SessionRows) > 0 {
		PrintSessionsBlock(w, caps, in.SessionRows)
	}

	if in.ResultLabel != "" {
		fmt.Fprintln(w)
		PrintResult(w, caps, in.ResultLabel, in.ResultTone)
	}
}

// PrintSessionsBlock renders the labeled session counts under the quota bars.
// Indented one space deeper than the quota rows so the block reads as a
// nested table. Counts use thousands separators (1,234) for legibility.
func PrintSessionsBlock(w io.Writer, caps Caps, rows []SessionRow) {
	if len(rows) == 0 {
		return
	}
	maxLabel := 0
	for _, r := range rows {
		if l := len(r.Label); l > maxLabel {
			maxLabel = l
		}
	}
	maxCount := 0
	formatted := make([]string, len(rows))
	for i, r := range rows {
		formatted[i] = GroupedInt(r.Count)
		if l := len(formatted[i]); l > maxCount {
			maxCount = l
		}
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %ssessions%s\n", caps.Palette.Dim, caps.Palette.Reset)
	for i, r := range rows {
		fmt.Fprintf(w, "    %s%-*s%s  %*s\n",
			caps.Palette.Dim, maxLabel, r.Label, caps.Palette.Reset,
			maxCount, formatted[i],
		)
	}
}

// MinimalScreen renders the dumb-terminal two-line summary.
func PrintMinimalScreen(w io.Writer, in ScreenInput) {
	caps := DetectCaps(in.Theme)
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
	_ = caps
}

// nowStamp is exposed for tests.
var nowStamp = func() time.Time { return time.Now() }

func strOr(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

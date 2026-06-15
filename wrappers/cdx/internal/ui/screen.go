package ui

import (
	"fmt"
	"io"
	"strings"
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

	HostFQDN  string
	Insecure  bool
	BrowserOS bool

	Lane     string // "normal" | "spark" | ""
	APICalls int64  // request count — shown in compact format

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

	// Context line: insecure · lane · calls
	ctxParts := []string{}
	if in.Insecure {
		ctxParts = append(ctxParts, caps.Palette.Yellow+"🔓 insecure"+caps.Palette.Reset)
	}
	if in.Concurrent {
		ctxParts = append(ctxParts, caps.Palette.Yellow+"concurrent run"+caps.Palette.Reset)
	}
	if in.BrowserOS {
		ctxParts = append(ctxParts, "BrowserOS")
	}
	if in.Lane != "" {
		laneTxt := in.Lane
		if in.Lane == "spark" {
			laneTxt = caps.BannerSym.IconSpark + " spark"
		}
		ctxParts = append(ctxParts, laneTxt)
	}
	if in.APICalls > 0 {
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

// PrintSessionsBlock renders the labeled session counts in a 2-column grid
// under the quota bars. The four canonical rows pair naturally:
//
//	local now  N      fleet now  N
//	today      N      month      N
//
// — "now" indicators left, totals right. Cell widths are computed across all
// entries so both columns line up. When fewer than four rows are supplied
// the trailing cell is left blank; the function still renders something
// usable. Counts use thousands separators (1,234) for legibility.
func PrintSessionsBlock(w io.Writer, caps Caps, rows []SessionRow) {
	if len(rows) == 0 {
		return
	}
	maxLabel := 0
	formatted := make([]string, len(rows))
	maxCount := 0
	for i, r := range rows {
		if l := len(r.Label); l > maxLabel {
			maxLabel = l
		}
		formatted[i] = GroupedInt(r.Count)
		if l := len(formatted[i]); l > maxCount {
			maxCount = l
		}
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %ssessions%s\n", caps.Palette.Dim, caps.Palette.Reset)
	const gridGap = "      " // visual separator between the two columns
	for i := 0; i < len(rows); i += 2 {
		left := sessionCell(caps, rows[i].Label, formatted[i], maxLabel, maxCount)
		right := ""
		if i+1 < len(rows) {
			right = sessionCell(caps, rows[i+1].Label, formatted[i+1], maxLabel, maxCount)
		}
		fmt.Fprintf(w, "    %s%s%s\n", left, gridGap, right)
	}
}

func sessionCell(caps Caps, label, value string, labelW, valueW int) string {
	return fmt.Sprintf("%s%-*s%s  %*s",
		caps.Palette.Dim, labelW, label, caps.Palette.Reset,
		valueW, value,
	)
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

func strOr(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

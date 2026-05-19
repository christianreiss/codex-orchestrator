package ui

import (
	"fmt"
	"io"
	"time"
)

// ExitFooter is the post-run summary block shown after Codex exits.
type ExitFooter struct {
	When        time.Time
	HeaderText  string // e.g. "Run summary"
	Tokens      *TokenUsage
	RunDuration time.Duration
	UsageStatus string // "uploaded" | "skipped (...)" | "failed (...)"
	UsageTone   Tone
	AuthStatus  string // "not-needed" | "uploaded" | "skipped (...)"
	AuthTone    Tone
	// CodexVersion is mis-named for engine symmetry — for clx it holds the
	// post-install claude version when the auto-update path swapped the
	// binary on this run. Empty for the common no-op case; when set, an
	// extra `● claude X.Y.Z` badge is added to the Sync row.
	CodexVersion string
}

// TokenUsage mirrors the auth-response shape so callers can pass either.
type TokenUsage struct {
	Total     int64
	Input     int64
	Output    int64
	Cached    int64
	Reasoning int64
}

// PrintExitFooter draws:
//
//	────────────────────────────
//	cdx 2026-05-19 14:23  ·  Run summary
//	Run usage  ·  sent=N, input=…, output=…, cached=…, reasoning=…
//	Run time   ·  Xm Ys
//	Sync       ·  ● usage uploaded  ● auth not-needed
//	────────────────────────────
func PrintExitFooter(w io.Writer, caps Caps, prefix string, f ExitFooter) {
	if w == nil {
		return
	}
	if f.HeaderText == "" {
		f.HeaderText = "Run summary"
	}
	when := f.When
	if when.IsZero() {
		when = time.Now()
	}
	Divider(w, caps)
	Header(w, caps, fmt.Sprintf("%s %s", prefix, when.Format("2006-01-02 15:04")), f.HeaderText)

	if f.Tokens != nil {
		t := f.Tokens
		fmt.Fprintf(w, "  %sRun usage %s ·  sent=%s, input=%s, output=%s, cached=%s, reasoning=%s\n",
			caps.Palette.Dim, caps.Palette.Reset,
			GroupedInt(t.Total),
			GroupedInt(t.Input),
			GroupedInt(t.Output),
			GroupedInt(t.Cached),
			GroupedInt(t.Reasoning),
		)
	}

	durCol := caps.Palette.Reset
	switch {
	case f.RunDuration < 60*time.Second:
		durCol = caps.Palette.Green
	case f.RunDuration > 5*time.Minute:
		durCol = caps.Palette.Yellow
	}
	fmt.Fprintf(w, "  %sRun time  %s ·  %s%s%s\n",
		caps.Palette.Dim, caps.Palette.Reset,
		durCol, DurationShort(f.RunDuration), caps.Palette.Reset,
	)

	syncLine := fmt.Sprintf("  %sSync      %s ·  %s  %s",
		caps.Palette.Dim, caps.Palette.Reset,
		footerDot(caps, "usage "+f.UsageStatus, f.UsageTone),
		footerDot(caps, "auth "+f.AuthStatus, f.AuthTone),
	)
	if f.CodexVersion != "" {
		syncLine += "  " + footerDot(caps, "claude "+f.CodexVersion, ToneOK)
	}
	fmt.Fprintln(w, syncLine)
	Divider(w, caps)
}

func footerDot(caps Caps, text string, tone Tone) string {
	col := tonePalette(caps, tone)
	return col + caps.BannerSym.DotOK + caps.Palette.Reset + " " + text
}

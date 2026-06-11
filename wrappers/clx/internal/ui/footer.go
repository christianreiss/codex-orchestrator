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
	RunDuration time.Duration
	AuthStatus  string // "not-needed" | "uploaded" | "skipped (...)"
	AuthTone    Tone
	// CodexVersion is mis-named for engine symmetry — for clx it holds the
	// post-install claude version when the auto-update path swapped the
	// binary on this run. Empty for the common no-op case; when set, an
	// extra `● claude X.Y.Z` badge is added to the Sync row.
	CodexVersion string
}

// PrintExitFooter draws:
//
//	────────────────────────────
//	cdx 2026-05-19 14:23  ·  Run summary
//	Run time   ·  Xm Ys
//	Sync       ·  ● auth not-needed
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

	syncLine := fmt.Sprintf("  %sSync      %s ·  %s",
		caps.Palette.Dim, caps.Palette.Reset,
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

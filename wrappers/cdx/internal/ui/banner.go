package ui

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// BannerArtCDX is the neofetch-style 6-row "CDX" ASCII logo.
var BannerArtCDX = []string{
	` ██████╗  ██████╗  ██╗  ██╗`,
	` ██╔════╝ ██╔══██╗ ╚██╗██╔╝`,
	` ██║      ██║  ██║  ╚███╔╝ `,
	` ██║      ██║  ██║  ██╔██╗ `,
	` ╚██████╗ ██████╔╝ ██╔╝ ██╗`,
	`  ╚═════╝ ╚═════╝  ╚═╝  ╚═╝`,
}

// BannerInfo is the right-hand column rendered next to the logo.
type BannerInfo struct {
	Title       string // "codex orchestrator"
	Tagline     string // "Codex to Brrr!"
	CodexLine   string // "codex    2026.05.11"
	WrapperLine string // "wrapper  2026.05.11-01"
	ContextLine string // "normal · 1.2M tokens"
	Tone        string // "green" | "yellow" | "red"  — used by status to color version lines
}

// PrintBoot draws the boot screen — art on the left, info on the right, padded.
// Stacks vertically when the terminal is narrower than 60 cols.
func PrintBoot(w io.Writer, caps Caps, info BannerInfo) {
	if w == nil {
		w = os.Stderr
	}
	if os.Getenv("CDX_SKIP_BANNER") == "1" {
		return
	}
	art := BannerArtCDX
	color := caps.BannerColor()
	reset := caps.Palette.Reset

	infoLines := []string{
		"", // L0 blank offset
		coloredOrEmpty(info.Title, caps.Palette.Bold+caps.BannerColor(), reset),
		coloredOrEmpty(info.Tagline, caps.Palette.Dim, reset),
		coloredOrEmpty(strings.Repeat("─", 25), caps.Palette.Dim, reset),
		coloredOrEmpty(info.CodexLine, "", reset),
		coloredOrEmpty(info.WrapperLine, "", reset),
		coloredOrEmpty(info.ContextLine, caps.Palette.Dim, reset),
	}

	if caps.Columns < 60 {
		// Stack art then info under it.
		for _, l := range art {
			fmt.Fprintln(w, color+l+reset)
		}
		for _, l := range infoLines {
			if l != "" {
				fmt.Fprintln(w, l)
			}
		}
		return
	}

	// Side-by-side. Art width = visible width of first art line.
	artWidth := VisibleWidth(art[0])
	gap := "    "
	for i := 0; i < len(art); i++ {
		left := PadRight(color+art[i]+reset, artWidth+len(color)+len(reset)) + gap
		right := ""
		if i+1 < len(infoLines) {
			right = infoLines[i+1]
		}
		fmt.Fprintln(w, left+right)
	}
}

func coloredOrEmpty(s, prefix, suffix string) string {
	if s == "" {
		return ""
	}
	if prefix == "" {
		return s
	}
	return prefix + s + suffix
}

// Divider draws a horizontal dim divider matching the boot/exit footer width.
func Divider(w io.Writer, caps Caps) {
	width := caps.Columns - 2
	if width < 20 {
		width = 20
	}
	char := caps.BannerSym.BoxH
	fmt.Fprintln(w, caps.Palette.Dim+strings.Repeat(char, width)+caps.Palette.Reset)
}

// Header prints a dim "cdx <ts> · <text>" line below a divider.
func Header(w io.Writer, caps Caps, prefix, body string) {
	fmt.Fprintln(w, caps.Palette.Dim+prefix+caps.Palette.Reset+"  ·  "+body)
}


package ui

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// BannerArtCLX is the neofetch-style 6-row "CLX" ASCII logo.
var BannerArtCLX = []string{
	`  ██████╗ ██╗     ██╗  ██╗`,
	` ██╔════╝ ██║     ╚██╗██╔╝`,
	` ██║      ██║      ╚███╔╝ `,
	` ██║      ██║      ██╔██╗ `,
	` ╚██████╗ ███████╗██╔╝ ██╗`,
	`  ╚═════╝ ╚══════╝╚═╝  ╚═╝`,
}

type BannerInfo struct {
	Title       string
	Tagline     string
	ClaudeLine  string
	WrapperLine string
	ContextLine string
	Tone        string
}

// PrintBoot draws the boot screen. clx uses violet/magenta as the banner colour.
func PrintBoot(w io.Writer, caps Caps, info BannerInfo) {
	if w == nil {
		w = os.Stderr
	}
	if os.Getenv("CLX_SKIP_BANNER") == "1" {
		return
	}
	art := BannerArtCLX
	color := caps.Palette.Violet + caps.Palette.Bold
	reset := caps.Palette.Reset

	infoLines := []string{
		"",
		coloredOrEmpty(info.Title, caps.Palette.Bold+caps.Palette.Violet, reset),
		coloredOrEmpty(info.Tagline, caps.Palette.Dim, reset),
		coloredOrEmpty(strings.Repeat("─", 25), caps.Palette.Dim, reset),
		coloredOrEmpty(info.ClaudeLine, "", reset),
		coloredOrEmpty(info.WrapperLine, "", reset),
		coloredOrEmpty(info.ContextLine, caps.Palette.Dim, reset),
	}

	if caps.Columns < 60 {
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

	artWidth := VisibleWidth(art[0])
	gap := "    "
	for i := 0; i < len(art); i++ {
		left := PadRight(color+art[i]+reset, artWidth) + gap
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

func Divider(w io.Writer, caps Caps) {
	width := caps.Columns - 2
	if width < 20 {
		width = 20
	}
	char := caps.BannerSym.BoxH
	fmt.Fprintln(w, caps.Palette.Dim+strings.Repeat(char, width)+caps.Palette.Reset)
}

func Header(w io.Writer, caps Caps, prefix, body string) {
	fmt.Fprintln(w, caps.Palette.Dim+prefix+caps.Palette.Reset+"  ·  "+body)
}


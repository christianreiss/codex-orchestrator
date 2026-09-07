package terminalui

import (
	"fmt"
	"io"
	"strings"
)

// HelpItem is authored by each persona; its layout is shared.
type HelpItem struct{ Usage, Description string }

func PrintWrapperHelp(w io.Writer, caps Caps, prefix, upstream string, commands, flags []HelpItem) {
	if w == nil {
		return
	}
	caps = engineCaps(caps, prefix)
	prefix = strings.ToUpper(CleanInline(prefix))
	upstream = CleanInline(upstream)
	tagline := "Fleet-managed " + upstream + " launcher and sync wrapper."
	if !caps.IsTTY || caps.Dumb || caps.Columns < minRichColumns {
		width := caps.Columns
		if width <= 0 {
			width = 80
		}
		if width > maxCardWidth {
			width = maxCardWidth
		}
		printPlainParagraph(w, prefix+" WRAPPER HELP", width, 0)
		printPlainParagraph(w, tagline, width, 0)
		fmt.Fprintln(w)
		printPlainParagraph(w, "Commands", width, 0)
		printPlainHelpItems(w, width, commands)
		fmt.Fprintln(w)
		printPlainParagraph(w, "Global flags", width, 0)
		printPlainHelpItems(w, width, flags)
		fmt.Fprintln(w)
		printPlainParagraph(w, "--help opens "+upstream+" help; --wrapper-help opens this wrapper surface.", width, 0)
		return
	}
	c := newFrame(w, caps)
	c.top()
	c.line(joinSides(caps.BannerColor()+prefix+caps.Palette.Reset, caps.Palette.Bold+"WRAPPER HELP"+caps.Palette.Reset, c.inner, caps))
	for _, line := range WrapText(tagline, c.inner) {
		c.line(caps.Palette.Dim + line + caps.Palette.Reset)
	}
	c.divider("Commands")
	printRichHelpItems(c, commands)
	c.divider("Global flags")
	printRichHelpItems(c, flags)
	c.divider("Help routing")
	renderPlainText(c, "--help opens "+upstream+" help; --wrapper-help opens this wrapper surface.")
	c.bottom()
}

func printRichHelpItems(c card, items []HelpItem) {
	accent, reset, dim := c.caps.BannerColor(), c.caps.Palette.Reset, c.caps.Palette.Dim
	// One long alias must not force every short command into a stacked layout.
	// Allocate each row independently and wrap both columns without clipping.
	for _, item := range items {
		usage := CleanInline(item.Usage)
		if c.inner >= 60 && VisibleWidth(usage) <= 32 {
			usageWidth := 30
			if VisibleWidth(usage) > usageWidth {
				usageWidth = 32
			}
			for i, line := range WrapText(item.Description, c.inner-usageWidth-3) {
				left := ""
				if i == 0 {
					left = accent + usage + reset
				}
				c.line(PadRight(left, usageWidth) + "   " + dim + line + reset)
			}
			continue
		}
		for _, line := range WrapText(usage, c.inner) {
			c.line(accent + line + reset)
		}
		for _, line := range WrapText(item.Description, c.inner-2) {
			c.line("  " + dim + line + reset)
		}
	}
}

func printPlainHelpItems(w io.Writer, width int, items []HelpItem) {
	for _, item := range items {
		printPlainParagraph(w, item.Usage, width, 2)
		printPlainParagraph(w, item.Description, width, 4)
	}
}

func printPlainParagraph(w io.Writer, text string, width, indent int) {
	if width <= 0 {
		return
	}
	if indent >= width {
		indent = 0
	}
	prefix := strings.Repeat(" ", indent)
	for _, line := range WrapText(PlainInline(text), width-len(prefix)) {
		fmt.Fprintln(w, prefix+line)
	}
}

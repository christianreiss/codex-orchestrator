package ui

import (
	"fmt"
	"io"
	"strings"
)

type wrapperHelpItem struct {
	usage       string
	description string
}

var clxHelpCommands = []wrapperHelpItem{
	{"clx [run] [args...]", "Sync managed state, then launch Claude."},
	{"clx resume [session] [prompt]", "Sync, then reopen a Claude session; omit the session for the picker."},
	{"clx exec -- <args...>", "Run Claude directly after local preflight, without the managed sync screen."},
	{"clx --execute <prompt>", "Run a managed headless one-shot prompt."},
	{"clx status", "Show host context, wrapper/Claude versions, auth/runner health, model, and API calls."},
	{"clx doctor", "Check dependencies, paths, auth, API reachability, config, and cron."},
	{"clx auth-upload", "Validate and upload local Claude credentials to the fleet store."},
	{"clx sync", "Write fleet-managed CLAUDE.md, settings, MCP servers, agents, and skills without launching Claude."},
	{"clx --update", "Download, verify, and install the fleet wrapper target."},
	{"clx --uninstall", "Remove managed auth, config, cron, and local Claude state."},
	{"clx --cron [install|remove|run]", "Install, remove, or run the managed update tick."},
}

var clxHelpFlags = []wrapperHelpItem{
	{"--wrapper-help", "Open this wrapper command surface."},
	{"-h, --help", "Open upstream Claude help, not wrapper help."},
	{"-V, -W, --version, --wrapper-version", "Print wrapper build and signing-key information."},
	{"--status", "Run the wrapper status command."},
	{"--doctor", "Run the wrapper diagnostics command."},
	{"-r, --resume[=<session>]", "Resume a session through the normal managed lifecycle."},
	{"-c, --continue", "Continue the most recent Claude conversation."},
	{"--execute <prompt>", "Run one managed headless prompt."},
	{"--dangerously-skip-permissions", "Bypass Claude permission prompts for this invocation only; never persisted."},
	{"-U, --update", "Update the clx wrapper now."},
	{"--uninstall", "Remove managed clx and Claude state."},
	{"--cron [install|remove|run]", "Manage or run the update tick."},
	{"--minimal, --minimal-output", "Use compact ASCII wrapper output."},
	{"--silent", "Suppress the boot screen and non-error wrapper logging."},
	{"--debug, --verbose", "Enable detailed wrapper diagnostics."},
	{"--skip-boot, --no-banner", "Launch without the boot screen or exit footer."},
	{"-4, --ipv4", "Force wrapper-managed network traffic through IPv4."},
	{"--allow-concurrent-sync", "Allow managed writes while another clx session is active."},
	{"--config <path>", "Load a specific signed wrapper configuration."},
}

// PrintWrapperHelp renders the clx-owned command surface. Upstream Claude help
// remains available through --help; --wrapper-help selects this renderer.
func PrintWrapperHelp(w io.Writer, caps Caps) {
	if w == nil {
		return
	}
	if !caps.IsTTY || caps.Dumb || caps.Columns < minRichColumns {
		printPlainWrapperHelp(w, caps, "CLX", "Fleet-managed Claude launcher and sync wrapper.", clxHelpCommands, clxHelpFlags, "Claude")
		return
	}

	c := newCard(w, caps)
	accent := caps.BannerColor()
	reset := caps.Palette.Reset
	c.top()
	c.line(joinSides(accent+"CLX"+reset, caps.Palette.Bold+"WRAPPER HELP"+reset, c.inner, caps))
	for _, line := range WrapText("Fleet-managed Claude launcher and sync wrapper.", c.inner) {
		c.line(caps.Palette.Dim + line + reset)
	}
	c.divider("Commands")
	printRichHelpItems(c, clxHelpCommands, accent)
	c.divider("Global flags")
	printRichHelpItems(c, clxHelpFlags, accent)
	c.divider("Help routing")
	for _, line := range WrapText("--help opens Claude help; --wrapper-help opens this wrapper surface.", c.inner) {
		c.line(caps.Palette.Dim + line + reset)
	}
	c.bottom()
}

func printRichHelpItems(c card, items []wrapperHelpItem, accent string) {
	usageWidth := 0
	for _, item := range items {
		if width := VisibleWidth(item.usage); width > usageWidth {
			usageWidth = width
		}
	}
	const minDescriptionWidth = 24
	aligned := c.inner >= usageWidth+3+minDescriptionWidth
	reset := c.caps.Palette.Reset
	dim := c.caps.Palette.Dim

	for _, item := range items {
		if aligned {
			descriptionWidth := c.inner - usageWidth - 3
			lines := WrapText(item.description, descriptionWidth)
			for i, line := range lines {
				usage := ""
				if i == 0 {
					usage = accent + item.usage + reset
				}
				c.line(PadRight(usage, usageWidth) + "   " + dim + line + reset)
			}
			continue
		}

		for _, line := range WrapText(item.usage, c.inner) {
			c.line(accent + line + reset)
		}
		descriptionWidth := c.inner - 2
		if descriptionWidth < 1 {
			descriptionWidth = c.inner
		}
		for _, line := range WrapText(item.description, descriptionWidth) {
			prefix := "  "
			if descriptionWidth == c.inner {
				prefix = ""
			}
			c.line(prefix + dim + line + reset)
		}
	}
}

func printPlainWrapperHelp(w io.Writer, caps Caps, engine, tagline string, commands, flags []wrapperHelpItem, upstream string) {
	width := caps.Columns
	if width <= 0 {
		width = 80
	}
	if width > maxCardWidth {
		width = maxCardWidth
	}
	printPlainParagraph(w, engine+" WRAPPER HELP", width, 0)
	printPlainParagraph(w, tagline, width, 0)
	fmt.Fprintln(w)
	printPlainParagraph(w, "Commands", width, 0)
	printPlainHelpItems(w, width, commands)
	fmt.Fprintln(w)
	printPlainParagraph(w, "Global flags", width, 0)
	printPlainHelpItems(w, width, flags)
	fmt.Fprintln(w)
	printPlainParagraph(w, "--help opens "+upstream+" help; --wrapper-help opens this wrapper surface.", width, 0)
}

func printPlainHelpItems(w io.Writer, width int, items []wrapperHelpItem) {
	for _, item := range items {
		printPlainParagraph(w, item.usage, width, 2)
		printPlainParagraph(w, item.description, width, 4)
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
	available := width - VisibleWidth(prefix)
	for _, line := range WrapText(text, available) {
		fmt.Fprintln(w, prefix+line)
	}
}

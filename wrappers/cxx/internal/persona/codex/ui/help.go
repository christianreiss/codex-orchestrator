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

var cdxHelpCommands = []wrapperHelpItem{
	{"cdx [run] [args...]", "Sync managed state, then launch Codex."},
	{"cdx resume [session] [prompt]", "Sync, then reopen a Codex session; omit the session for the picker."},
	{"cdx exec -- <args...>", "Run Codex directly after local preflight, without the managed sync screen."},
	{"cdx --execute <prompt>", "Run a headless, read-only one-shot prompt through the managed lifecycle."},
	{"cdx status", "Show host context, wrapper/Codex versions, auth/runner health, and quota."},
	{"cdx doctor", "Check dependencies, paths, auth, API reachability, config, and cron."},
	{"cdx auth-upload", "Validate and upload local Codex credentials to the fleet store."},
	{"cdx sync", "Write fleet-managed AGENTS.md, config.toml, and skills without launching Codex."},
	{"cdx lane [normal|spark|clear]", "Inspect or persist a quota lane; clear restores the inherited default. Legacy --persist is accepted."},
	{"cdx ls", "Shortcut for cdx lane spark."},
	{"cdx profile <name> [-- args...]", "Launch Codex with a named profile from the synced config."},
	{"cdx --update", "Download, verify, and install the fleet wrapper target."},
	{"cdx --uninstall", "Remove managed auth, config, cron, and local Codex state."},
	{"cdx --cron [install|remove|run]", "Install, remove, or run the managed update tick."},
}

var cdxHelpFlags = []wrapperHelpItem{
	{"--wrapper-help", "Open this wrapper command surface."},
	{"-h, --help", "Open upstream Codex help, not wrapper help."},
	{"-V, -W, --version, --wrapper-version", "Print wrapper build and signing-key information."},
	{"--status", "Run the wrapper status command."},
	{"--doctor", "Run the wrapper diagnostics command."},
	{"--resume[=<session>]", "Resume a session through the normal managed lifecycle."},
	{"--execute <prompt>", "Run one managed headless prompt."},
	{"-U, --update", "Update the cdx wrapper now."},
	{"--uninstall", "Remove managed cdx and Codex state."},
	{"--cron [install|remove|run]", "Manage or run the update tick."},
	{"--minimal, --minimal-output", "Use compact ASCII wrapper output."},
	{"--silent", "Suppress the boot screen and non-error wrapper logging."},
	{"--debug, --verbose", "Enable detailed wrapper diagnostics."},
	{"--skip-boot, --no-banner", "Launch without the boot screen or exit footer."},
	{"-4, --ipv4", "Force wrapper-managed network traffic through IPv4."},
	{"--allow-concurrent-sync", "Allow managed writes while another cdx session is active."},
	{"--config <path>", "Load a specific signed wrapper configuration."},
}

// PrintWrapperHelp renders the cdx-owned command surface. Upstream Codex help
// remains available through --help; --wrapper-help selects this renderer.
func PrintWrapperHelp(w io.Writer, caps Caps) {
	if w == nil {
		return
	}
	if !caps.IsTTY || caps.Dumb || caps.Columns < minRichColumns {
		printPlainWrapperHelp(w, caps, "CDX", "Fleet-managed Codex launcher and sync wrapper.", cdxHelpCommands, cdxHelpFlags, "Codex")
		return
	}

	c := newCard(w, caps)
	accent := caps.BannerColor()
	reset := caps.Palette.Reset
	c.top()
	c.line(joinSides(accent+"CDX"+reset, caps.Palette.Bold+"WRAPPER HELP"+reset, c.inner, caps))
	for _, line := range WrapText("Fleet-managed Codex launcher and sync wrapper.", c.inner) {
		c.line(caps.Palette.Dim + line + reset)
	}
	c.divider("Commands")
	printRichHelpItems(c, cdxHelpCommands, accent)
	c.divider("Global flags")
	printRichHelpItems(c, cdxHelpFlags, accent)
	c.divider("Help routing")
	for _, line := range WrapText("--help opens Codex help; --wrapper-help opens this wrapper surface.", c.inner) {
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

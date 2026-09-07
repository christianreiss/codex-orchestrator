package ui

import (
	"io"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

type wrapperHelpItem struct {
	usage       string
	description string
}

var cdxHelpCommands = []wrapperHelpItem{
	{"cdx [run] [args...]", "Sync managed state, then launch Codex."},
	{"cdx resume [session] [prompt]", "Reopen a session, or choose one."},
	{"cdx exec -- <args...>", "Local preflight, then direct execution."},
	{"cdx --execute <prompt>", "One prompt under the fleet policy."},
	{"cdx status", "Host, versions, health and usage."},
	{"cdx doctor", "Diagnose and show repair steps."},
	{"cdx auth-upload", "Verify and upload local credentials."},
	{"cdx sync", "Apply managed files without launching."},
	{"cdx lane [normal|spark|clear]", "Choose a quota lane; clear to inherit."},
	{"cdx ls", "Shortcut for cdx lane spark."},
	{"cdx profile <name> [-- args...]", "Launch a synced configuration profile."},
	{"cdx --update", "Verify and install the wrapper target."},
	{"cdx --uninstall", "Remove wrapper and managed engine state."},
	{"cdx --cron [install|remove|run]", "Manage the background update schedule."},
}

var cdxHelpFlags = []wrapperHelpItem{
	{"--wrapper-help", "Show wrapper commands and flags."},
	{"-h, --help", "Show upstream Codex help."},
	{"-V, -W, --version, --wrapper-version", "Wrapper version and signing key."},
	{"--status", "Show the current host status."},
	{"--doctor", "Run diagnostics and repair guidance."},
	{"--resume[=<session>]", "Resume with managed synchronization."},
	{"--execute <prompt>", "One headless prompt under fleet policy."},
	{"-U, --update", "Update the wrapper now."},
	{"--uninstall", "Remove managed wrapper and engine state."},
	{"--cron [install|remove|run]", "Manage or run the update tick."},
	{"--minimal, --minimal-output", "Portable, compact ASCII output."},
	{"--silent", "Hide startup and non-error logging."},
	{"--debug, --verbose", "Detailed wrapper diagnostics."},
	{"--skip-boot, --no-banner", "Hide startup and the session footer."},
	{"-4, --ipv4", "Use IPv4 for wrapper network traffic."},
	{"--allow-concurrent-sync", "Allow managed writes during a session."},
	{"--config <path>", "Read a signed wrapper configuration."},
}

func PrintWrapperHelp(w io.Writer, caps Caps) {
	terminalui.PrintWrapperHelp(w, caps, "cdx", "Codex", helpItems(cdxHelpCommands), helpItems(cdxHelpFlags))
}
func helpItems(items []wrapperHelpItem) []terminalui.HelpItem {
	out := make([]terminalui.HelpItem, len(items))
	for i, item := range items {
		out[i] = terminalui.HelpItem{Usage: item.usage, Description: item.description}
	}
	return out
}

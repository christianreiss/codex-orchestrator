package ui

import (
	"io"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

type wrapperHelpItem struct {
	usage       string
	description string
}

var clxHelpCommands = []wrapperHelpItem{
	{"clx [run] [args...]", "Sync managed state, then launch Claude."},
	{"clx resume [session] [prompt]", "Reopen a session, or choose one."},
	{"clx exec -- <args...>", "Local preflight, then direct execution."},
	{"clx --execute <prompt>", "One prompt under the fleet policy."},
	{"clx status", "Host, versions, health and usage."},
	{"clx doctor", "Diagnose and show repair steps."},
	{"clx auth-upload", "Verify and upload local credentials."},
	{"clx sync", "Apply managed files without launching."},
	{"clx --update", "Verify and install the wrapper target."},
	{"clx --uninstall", "Remove wrapper and managed engine state."},
	{"clx cron [install|remove|run]", "Manage the background update schedule."},
}

var clxHelpFlags = []wrapperHelpItem{
	{"--wrapper-help", "Show wrapper commands and flags."},
	{"-h, --help", "Show upstream Claude help."},
	{"-V, -W, --version, --wrapper-version", "Wrapper version and signing key."},
	{"--status", "Show the current host status."},
	{"--doctor", "Run diagnostics and repair guidance."},
	{"-r, --resume[=<session>]", "Resume with managed synchronization."},
	{"-c, --continue", "Continue the latest conversation."},
	{"--execute <prompt>", "One headless prompt under fleet policy."},
	{"--dangerously-skip-permissions", "Bypass prompts for this run only."},
	{"-U, --update", "Update the wrapper now."},
	{"--uninstall", "Remove managed wrapper and engine state."},
	{"--cron [install|remove|run]", "Manage or run the update tick."},
	{"--minimal, --minimal-output", "Portable, compact ASCII output."},
	{"--silent", "Hide startup and non-error logging."},
	{"--debug, --verbose", "Detailed wrapper diagnostics."},
	{"--quota-choice-reset", "Forget today's provider choice before starting."},
	{"--skip-boot, --no-banner", "Hide startup and the session footer."},
	{"-4, --ipv4", "Use IPv4 for wrapper network traffic."},
	{"--allow-concurrent-sync", "Allow managed writes during a session."},
	{"--config <path>", "Read a signed wrapper configuration."},
}

func PrintWrapperHelp(w io.Writer, caps Caps) {
	terminalui.PrintWrapperHelp(w, caps, "clx", "Claude", helpItems(clxHelpCommands), helpItems(clxHelpFlags))
}
func helpItems(items []wrapperHelpItem) []terminalui.HelpItem {
	out := make([]terminalui.HelpItem, len(items))
	for i, item := range items {
		out[i] = terminalui.HelpItem{Usage: item.usage, Description: item.description}
	}
	return out
}

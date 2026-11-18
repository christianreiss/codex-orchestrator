// Package launchcard folds per-launch runtime facts (host daemon, communicator)
// into the boot card so every engine renders one coherent startup screen
// instead of loose lines around it.
package launchcard

import (
	"context"
	"io"
	"log/slog"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentbus"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

// AddDaemon adds the host daemon dot and, on failure, its problem line.
func AddDaemon(info *terminalui.LaunchInfo, status agentbus.HostDaemonStatus) {
	if !status.Shown {
		return
	}
	if !status.OK {
		info.AddDot("daemon", terminalui.ToneWarn, false)
		info.AddProblem(status.Problem)
		return
	}
	info.AddDot("daemon", terminalui.ToneOK, status.Restarted)
}

// AddCommunicator snapshots the communicator owner into the card.
func AddCommunicator(info *terminalui.LaunchInfo, stats *communicator.LifecycleStats) {
	if stats == nil {
		return
	}
	line, configured, ok := stats.StartSummary()
	if !configured {
		return
	}
	if !ok {
		info.AddDot("communicator", terminalui.ToneWarn, false)
		info.AddProblem("communicator unavailable; peer messaging may be delayed")
		return
	}
	info.AddDot("communicator", terminalui.ToneOK, false)
	info.Communicator = line
}

// PrintVerbose writes the diagnostic detail the card summarizes: the captured
// systemctl output and the communicator attachment matrix. Callers invoke it
// only in debug/verbose mode, after the card.
func PrintVerbose(w io.Writer, caps terminalui.Caps, prefix string, daemon agentbus.HostDaemonStatus, stats *communicator.LifecycleStats) {
	if daemon.Output != "" {
		terminalui.PrintNotice(w, caps, terminalui.Notice{Prefix: prefix, Tone: terminalui.ToneDim, Topic: "daemon", Message: daemon.Output})
	}
	if stats != nil {
		if table := stats.Table(); len(table) > 0 {
			terminalui.PrintNotice(w, caps, terminalui.Notice{Prefix: prefix, Tone: terminalui.ToneDim, Topic: "communicator", Message: "attachments", Details: stats.Details(), Table: table})
		}
	}
}

// PrintEnd writes the one-line communicator state at exit.
func PrintEnd(w io.Writer, caps terminalui.Caps, prefix string, stats *communicator.LifecycleStats, verbose bool) {
	if stats == nil {
		return
	}
	line := stats.EndSummary()
	if line == "" {
		return
	}
	n := terminalui.Notice{Prefix: prefix, Tone: terminalui.ToneDim, Topic: "communicator", Message: line}
	if verbose {
		n.Details, n.Table = stats.Details(), stats.Table()
	}
	terminalui.PrintNotice(w, caps, n)
}

// Verbose reports whether the launch runs with debug logging (--debug/--verbose),
// which also restores the full diagnostic detail under the card.
func Verbose(ctx context.Context, logger *slog.Logger) bool {
	return logger != nil && logger.Enabled(ctx, slog.LevelDebug)
}

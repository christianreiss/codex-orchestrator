// Package ui adapts the claude persona to the shared terminal visual system.
package ui

import (
	"io"
	"os"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

type ScreenInput struct {
	LoginWarning   string
	WrapperVersion string
	WrapperTone    Tone
	WrapperTarget  string

	ClaudeVersion string
	ClaudeTone    Tone
	ClaudeTarget  string

	HostFQDN string
	Insecure bool
	Model    string
	Effort   string
	APICalls int64

	Concurrent        bool
	ConcurrentNote    string
	BypassPermissions bool
	Dots              []HealthDot
	QuotaRows         []QuotaRow
	QuotaWarn         string
	QuotaBlock        string
	SessionRows       []SessionRow

	ResultLabel string
	ResultTone  Tone
	Theme       string
}

func sharedScreen(in ScreenInput) terminalui.ScreenInput {
	return terminalui.ScreenInput{
		Prefix: "clx", EngineName: "claude",
		SkipBanner:        os.Getenv("CLX_SKIP_BANNER") == "1",
		WrapperVersion:    in.WrapperVersion,
		WrapperTone:       in.WrapperTone,
		WrapperTarget:     in.WrapperTarget,
		EngineVersion:     in.ClaudeVersion,
		EngineTone:        in.ClaudeTone,
		EngineTarget:      in.ClaudeTarget,
		HostFQDN:          in.HostFQDN,
		Insecure:          in.Insecure,
		Model:             in.Model,
		Effort:            in.Effort,
		APICalls:          in.APICalls,
		Concurrent:        in.Concurrent,
		ConcurrentNote:    in.ConcurrentNote,
		BypassPermissions: in.BypassPermissions,
		Dots:              in.Dots,
		QuotaRows:         in.QuotaRows,
		QuotaWarn:         in.QuotaWarn,
		QuotaBlock:        in.QuotaBlock,
		SessionRows:       in.SessionRows,
		ResultLabel:       in.ResultLabel,
		ResultTone:        in.ResultTone,
		Theme:             in.Theme,
	}
}
func PrintBootScreen(w io.Writer, in ScreenInput) {
	terminalui.PrintBootScreen(w, sharedScreen(in))
	printLoginWarning(w, in)
}
func PrintMinimalScreen(w io.Writer, in ScreenInput) {
	terminalui.PrintMinimalScreen(w, sharedScreen(in))
	printLoginWarning(w, in)
}

func printLoginWarning(w io.Writer, in ScreenInput) {
	if in.LoginWarning != "" {
		terminalui.Say(w, "clx", terminalui.ToneWarn, terminalui.TopicAuth, in.LoginWarning)
	}
}

// Package ui adapts the codex persona to the shared terminal visual system.
package ui

import (
	"io"
	"os"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

type ScreenInput struct {
	WrapperVersion string
	WrapperTone    Tone
	WrapperTarget  string

	CodexVersion string
	CodexTone    Tone
	CodexTarget  string

	HostFQDN  string
	Insecure  bool
	BrowserOS bool
	Model     string
	Effort    string
	Lane      string
	APICalls  int64

	Concurrent     bool
	ConcurrentNote string
	Dots           []HealthDot

	QuotaRows   []QuotaRow
	QuotaWarn   string
	QuotaBlock  string
	SessionRows []SessionRow

	ResultLabel string
	ResultTone  Tone
	Theme       string
}

func sharedScreen(in ScreenInput) terminalui.ScreenInput {
	return terminalui.ScreenInput{
		Prefix: "cdx", EngineName: "codex",
		SkipBanner:     os.Getenv("CDX_SKIP_BANNER") == "1",
		WrapperVersion: in.WrapperVersion,
		WrapperTone:    in.WrapperTone,
		WrapperTarget:  in.WrapperTarget,
		EngineVersion:  in.CodexVersion,
		EngineTone:     in.CodexTone,
		EngineTarget:   in.CodexTarget,
		HostFQDN:       in.HostFQDN,
		Insecure:       in.Insecure,
		BrowserOS:      in.BrowserOS,
		Model:          in.Model,
		Effort:         in.Effort,
		Lane:           in.Lane,
		APICalls:       in.APICalls,
		Concurrent:     in.Concurrent,
		ConcurrentNote: in.ConcurrentNote,
		Dots:           in.Dots,
		QuotaRows:      in.QuotaRows,
		QuotaWarn:      in.QuotaWarn,
		QuotaBlock:     in.QuotaBlock,
		SessionRows:    in.SessionRows,
		ResultLabel:    in.ResultLabel,
		ResultTone:     in.ResultTone,
		Theme:          in.Theme,
	}
}
func PrintBootScreen(w io.Writer, in ScreenInput) { terminalui.PrintBootScreen(w, sharedScreen(in)) }
func PrintMinimalScreen(w io.Writer, in ScreenInput) {
	terminalui.PrintMinimalScreen(w, sharedScreen(in))
}

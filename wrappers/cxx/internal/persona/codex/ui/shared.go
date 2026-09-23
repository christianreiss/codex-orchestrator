package ui

import (
	"io"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

type Theme = terminalui.Theme
type Palette = terminalui.Palette
type Caps = terminalui.Caps
type BannerGlyphs = terminalui.BannerGlyphs
type Tone = terminalui.Tone
type HealthDot = terminalui.HealthDot
type QuotaRow = terminalui.QuotaRow
type SessionRow = terminalui.SessionRow
type ExitFooter = terminalui.ExitFooter
type DoctorRow = terminalui.DoctorRow
type DoctorReport = terminalui.DoctorReport
type AuthChecker = terminalui.AuthChecker
type Notice = terminalui.Notice
type Question = terminalui.Question
type Option = terminalui.Option

const (
	ThemeAuto      = terminalui.ThemeAuto
	ThemeOrange    = terminalui.ThemeOrange
	ThemePink      = terminalui.ThemePink
	ThemeViolet    = terminalui.ThemeViolet
	ToneOK         = terminalui.ToneOK
	ToneWarn       = terminalui.ToneWarn
	ToneFail       = terminalui.ToneFail
	ToneDim        = terminalui.ToneDim
	BarWidth       = terminalui.BarWidth
	minRichColumns = terminalui.MinRichColumns

	TopicAuth      = terminalui.TopicAuth
	TopicConfig    = terminalui.TopicConfig
	TopicCron      = terminalui.TopicCron
	TopicLane      = terminalui.TopicLane
	TopicLogin     = terminalui.TopicLogin
	TopicProfile   = terminalui.TopicProfile
	TopicQuota     = terminalui.TopicQuota
	TopicSession   = terminalui.TopicSession
	TopicStatus    = terminalui.TopicStatus
	TopicSync      = terminalui.TopicSync
	TopicUninstall = terminalui.TopicUninstall
	TopicUpdate    = terminalui.TopicUpdate
	TopicUpload    = terminalui.TopicUpload
	TopicUsage     = terminalui.TopicUsage
)

var (
	MinimalCaps        = terminalui.MinimalCaps
	StripANSI          = terminalui.StripANSI
	VisibleWidth       = terminalui.VisibleWidth
	PadRight           = terminalui.PadRight
	CleanInline        = terminalui.CleanInline
	PlainInline        = terminalui.PlainInline
	TruncateText       = terminalui.TruncateText
	WrapText           = terminalui.WrapText
	CompactNumber      = terminalui.CompactNumber
	GroupedInt         = terminalui.GroupedInt
	DurationShort      = terminalui.DurationShort
	PrintHealthRow     = terminalui.PrintHealthRow
	PrintConcurrentRow = terminalui.PrintConcurrentRow
	PrintResult        = terminalui.PrintResult
	PrintQuotaRow      = terminalui.PrintQuotaRow
	BuildBar           = terminalui.BuildBar
	PrintQuotaReason   = terminalui.PrintQuotaReason
	ProjectUsage       = terminalui.ProjectUsage
	ProjectionReady    = terminalui.ProjectionReady
	ProjectETA         = terminalui.ProjectETA
	PrintDoctor        = terminalui.PrintDoctor
	PrintExitFooter    = terminalui.PrintExitFooter
	UpdateProgress     = terminalui.UpdateProgress
	UpdateComplete     = terminalui.UpdateComplete
	UpdateFailure      = terminalui.UpdateFailure
	Say                = terminalui.Say
	Sayf               = terminalui.Sayf
	PrintNotice        = terminalui.PrintNotice
	FormatNotice       = terminalui.FormatNotice
	Confirm            = terminalui.Confirm
	Select             = terminalui.Select
	ErrPromptCancelled = terminalui.ErrPromptCancelled
)

func DetectCaps(theme string) Caps { caps := terminalui.DetectCaps(theme); return caps }
func DetectCapsFor(w io.Writer, theme string) Caps {
	caps := terminalui.DetectCapsFor(w, theme)
	return caps
}

var PollApproval = terminalui.PollApprovalFor("cdx")

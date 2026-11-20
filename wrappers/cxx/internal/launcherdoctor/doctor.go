// Package launcherdoctor holds the doctor checks shared across engines: the
// local PATH launcher diagnostic and the rows cdx and clx doctor print alike.
package launcherdoctor

import (
	"context"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func Row(ctx context.Context, executable string, engines []string, fix bool) terminalui.DoctorRow {
	statuses, err := layout.CheckLaunchers(ctx, executable, engines, fix)
	row := terminalui.DoctorRow{Label: "Launchers", Tone: terminalui.ToneOK}
	var parts []string
	for _, s := range statuses {
		part := s.Name + "=" + s.State
		if s.Path != "" {
			part += " (" + s.Path + ")"
		}
		if s.Detail != "" {
			part += ": " + s.Detail
		}
		parts = append(parts, part)
		if s.State == "stale" {
			row.Tone = terminalui.ToneFail
		} else if s.State != "healthy" && s.State != "repaired" && row.Tone != terminalui.ToneFail {
			row.Tone = terminalui.ToneWarn
		}
	}
	if err != nil {
		if row.Tone != terminalui.ToneFail {
			row.Tone = terminalui.ToneWarn
		}
		parts = append(parts, err.Error())
	}
	row.Value = strings.Join(parts, "; ")
	return row
}

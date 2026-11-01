// Package quotaemulation renders server-owned budgets; it never invents local usage.
package quotaemulation

import (
	"fmt"
	"math"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

type Snapshot struct {
	Unlimited bool `json:"unlimited"`
	Emulation struct {
		Enabled     bool   `json:"enabled"`
		WindowHours int    `json:"window_hours"`
		Action      string `json:"action"`
		AutoResume  bool   `json:"auto_resume"`
	} `json:"emulation"`
	Policy struct {
		ShortWarnPercent *int `json:"short_warn_percent"`
	} `json:"policy"`
	Short *struct {
		Source       string  `json:"source"`
		UsedPercent  float64 `json:"used_percent"`
		LimitSeconds int64   `json:"limit_seconds"`
		ResetsAt     string  `json:"resets_at"`
		ObservedAt   string  `json:"observed_at"`
		Status       string  `json:"status"`
		Action       string  `json:"action"`
	} `json:"short"`
}

func Display(s *Snapshot, now time.Time) ([]terminalui.QuotaRow, string) {
	if s == nil || s.Unlimited || !s.Emulation.Enabled {
		return nil, ""
	}
	w := s.Short
	if w == nil {
		return nil, "Emulated quota unavailable; work allowed."
	}
	if w.Source != "emulated" {
		return nil, ""
	}
	if math.IsNaN(w.UsedPercent) || math.IsInf(w.UsedPercent, 0) || w.UsedPercent < 0 {
		return nil, "Emulated quota unavailable; work allowed."
	}
	row := terminalui.QuotaRow{Label: fmt.Sprintf("emulated %dh", w.LimitSeconds/3600), Used: int(math.Round(w.UsedPercent)), ResetUnknown: w.ResetsAt == ""}
	if s.Policy.ShortWarnPercent != nil {
		row.WarnAtPct = *s.Policy.ShortWarnPercent
	}
	reset, err := time.Parse(time.RFC3339, w.ResetsAt)
	observed, obsErr := time.Parse(time.RFC3339, w.ObservedAt)
	row.Stale = w.Status != "fresh" || obsErr != nil || now.Sub(observed) > 10*time.Minute || observed.After(now.Add(30*time.Second)) || (err == nil && !reset.After(now))
	if err == nil && reset.After(now) {
		row.ResetAfter = reset.Sub(now)
	}
	if row.Stale {
		row.Note = "last known reading"
		return []terminalui.QuotaRow{row}, "Emulated quota stale; work allowed."
	}
	if s.Policy.ShortWarnPercent == nil || w.UsedPercent < float64(*s.Policy.ShortWarnPercent) {
		return []terminalui.QuotaRow{row}, ""
	}
	advice := "suggest pause until reset"
	if w.Action == "suggest_ignore" {
		advice = "suggest ignore local budget and continue"
	}
	if w.Action == "hard_stop" {
		advice = "new managed work stops at 100%; current turn may finish"
		row.BlockAtPct = 100
	}
	return []terminalui.QuotaRow{row}, "Emulated quota: " + advice + "."
}

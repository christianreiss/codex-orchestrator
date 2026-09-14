// Package quotaadvice compares reported quotas without probing either provider.
package quotaadvice

import (
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
	"math"
	"time"
)

type Settings struct {
	Mode           string `json:"mode"`
	HighUsage      int    `json:"high_usage_percent"`
	ProjectedUsage int    `json:"projected_usage_percent"`
	MinGap         int    `json:"min_pressure_gap"`
	MaxAgeMinutes  int    `json:"max_age_minutes"`
	RememberDay    bool   `json:"remember_day"`
}
type Window struct {
	Used    *int   `json:"used_percent"`
	Seconds int64  `json:"limit_seconds"`
	ResetAt string `json:"reset_at"`
}
type Snapshot struct {
	Available    bool     `json:"available"`
	Status       string   `json:"status"`
	FetchedAt    string   `json:"fetched_at"`
	LimitReached bool     `json:"limit_reached"`
	Windows      []Window `json:"windows"`
}
type Comparison struct {
	Settings Settings `json:"settings"`
	Codex    Snapshot `json:"codex"`
	Claude   Snapshot `json:"claude"`
}
type Pressure struct {
	Valid         bool
	Score         float64
	Used          int
	Projected     int
	WindowSeconds int64
	ResetAt       time.Time
	Age           time.Duration
	Reason        string
}

func (c *Comparison) Snapshot(engine string) Snapshot {
	if engine == "codex" {
		return c.Codex
	}
	return c.Claude
}
func (s Settings) valid() bool {
	return (s.Mode == "off" || s.Mode == "hint" || s.Mode == "ask") && s.HighUsage >= 1 && s.HighUsage <= 100 && s.ProjectedUsage >= 100 && s.ProjectedUsage <= 500 && s.MinGap >= 1 && s.MinGap <= 100 && s.MaxAgeMinutes >= 1 && s.MaxAgeMinutes <= 120
}
func Evaluate(s Snapshot, cfg Settings, now time.Time) Pressure {
	bad := func(reason string) Pressure { return Pressure{Reason: reason} }
	if !cfg.valid() {
		return bad("invalid advice settings")
	}
	if !s.Available {
		return bad("provider not configured on this host")
	}
	if s.Status != "ok" && s.Status != "success" {
		return bad("quota telemetry unavailable")
	}
	fetched, err := time.Parse(time.RFC3339, s.FetchedAt)
	if err != nil || fetched.After(now.Add(time.Minute)) {
		return bad("invalid measurement timestamp")
	}
	age := now.Sub(fetched)
	if age > time.Duration(cfg.MaxAgeMinutes)*time.Minute {
		return bad("quota measurement is stale")
	}
	best := Pressure{Age: max(age, 0)}
	for _, w := range s.Windows {
		if w.Used == nil {
			continue
		}
		if *w.Used < 0 || *w.Used > 100 {
			return bad("invalid quota percentage")
		}
		reset, err := time.Parse(time.RFC3339, w.ResetAt)
		if err == nil && !reset.After(now) {
			return bad("quota reset passed; awaiting a new measurement")
		}
		if err == nil && w.Seconds > 0 && reset.Sub(fetched) > time.Duration(w.Seconds)*time.Second+time.Minute {
			return bad("reset outside quota window")
		}
		p := Pressure{Valid: true, Used: *w.Used, Age: max(age, 0), WindowSeconds: w.Seconds, Score: float64(*w.Used) * 100 / float64(cfg.HighUsage)}
		if err == nil {
			p.ResetAt = reset
			remaining := int64(reset.Sub(fetched) / time.Second)
			if terminalui.ProjectionReady(w.Seconds, remaining) {
				p.Projected = terminalui.ProjectUsage(*w.Used, w.Seconds, remaining)
				p.Score = math.Max(p.Score, float64(p.Projected)*100/float64(cfg.ProjectedUsage))
			}
		}
		if !best.Valid || p.Score > best.Score {
			best = p
		}
	}
	if !best.Valid {
		return bad("no measured quota windows")
	}
	if s.LimitReached {
		best.Score = math.Max(best.Score, 100)
	}
	return best
}
func Recommend(current, alternative Pressure, cfg Settings) bool {
	return current.Valid && alternative.Valid && current.Score >= 100 && alternative.Score < 100 && current.Score-alternative.Score >= float64(cfg.MinGap)
}
func (p Pressure) Description(now time.Time) string {
	if !p.Valid {
		return p.Reason
	}
	window := "quota"
	if p.WindowSeconds > 0 {
		window = (time.Duration(p.WindowSeconds) * time.Second).String() + " window"
	}
	reset := "reset unknown"
	if !p.ResetAt.IsZero() {
		reset = "resets in " + p.ResetAt.Sub(now).Round(time.Minute).String()
	}
	projection := ""
	if p.Projected > 0 {
		projection = fmt.Sprintf(", estimated %d%% at reset", p.Projected)
	}
	return fmt.Sprintf("%s: %d%% used%s; %s; measured %s ago", window, p.Used, projection, reset, p.Age.Round(time.Second))
}

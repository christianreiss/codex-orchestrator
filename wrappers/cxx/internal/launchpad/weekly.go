package launchpad

import (
	"fmt"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// LocalWeekly uses the same native-home/fleet/account scope as auth sync.
func LocalWeekly(engine string, cfg *config.Config) *accountpool.WeeklyUsage {
	var path string
	var err error
	switch engine {
	case config.EngineCodex:
		path, err = codex.AuthPath()
	case config.EngineClaude:
		path, err = claude.AuthPath()
	default:
		return nil // Grok has no weekly CLI quota observation.
	}
	if err != nil {
		return nil
	}
	return accountpool.Load(engine, path, strings.TrimRight(cfg.Orchestrator.BaseURL, "/")).CachedWeekly()
}

func weeklyText(q *accountpool.WeeklyUsage, now time.Time) (string, bool) {
	if q == nil || q.Used == nil || *q.Used < 0 || *q.Used > 100 {
		return "week --", false
	}
	fetched, err := time.Parse(time.RFC3339, q.FetchedAt)
	if err != nil || fetched.After(now.Add(time.Minute)) {
		return "week --", false
	}
	if reset, err := time.Parse(time.RFC3339, q.ResetAt); err == nil && !reset.After(now) {
		return "week --", false
	}
	text := fmt.Sprintf("week %d%% used", *q.Used)
	if now.Sub(fetched) > 30*time.Minute {
		return text + " (stale)", false
	}
	return text, true
}

func (p *picker) weeklyNotice(i int) string {
	if i >= len(p.engines) {
		return ""
	}
	q := p.engines[i].Weekly
	text, fresh := weeklyText(q, time.Now())
	if fresh && *q.Used >= 100 {
		return p.paint(p.caps.Palette.Red, text)
	}
	if fresh && *q.Used >= 85 {
		return p.paint(p.caps.Palette.Yellow, text)
	}
	return p.dim(text)
}

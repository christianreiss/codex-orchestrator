package launchpad

import (
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func TestLocalWeeklyUsesNativeAuthScopeAndNormalizedFleetURL(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	for _, engine := range []string{"codex", "claude"} {
		path, err := codex.AuthPath()
		quota := `"chatgpt":{"status":"ok","fetched_at":"2026-10-12T12:00:00Z","primary_used_percent":42,"primary_limit_seconds":604800}`
		if engine == "claude" {
			path, err = claude.AuthPath()
			quota = `"claude_usage":{"status":"ok","fetched_at":"2026-10-12T12:00:00Z","seven_day_used_percent":42}`
		}
		if err != nil {
			t.Fatal(err)
		}
		accountpool.Load(engine, path, "https://fleet.example").Observe("/auth", []byte(`{"account_id":7,"verification_state":"verified",`+quota+`}`))
		cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: "https://fleet.example/"}}
		if q := LocalWeekly(engine, cfg); q == nil || q.Used == nil || *q.Used != 42 {
			t.Fatalf("%s local cache unavailable: %+v", engine, q)
		}
	}
}

func TestWeeklyNoticesDistinguishZeroStaleAndUnknown(t *testing.T) {
	now := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name  string
		used  int
		age   time.Duration
		reset string
		want  string
		fresh bool
	}{
		{"zero", 0, time.Minute, "", "week 0% used", true},
		{"high", 95, time.Minute, "", "week 95% used", true},
		{"stale", 42, time.Hour, "", "week 42% used (stale)", false},
		{"future", 42, -2 * time.Minute, "", "week --", false},
		{"invalid", 101, 0, "", "week --", false},
		{"reset", 42, time.Minute, now.Add(-time.Second).Format(time.RFC3339), "week --", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &accountpool.WeeklyUsage{Used: &tc.used, FetchedAt: now.Add(-tc.age).Format(time.RFC3339), ResetAt: tc.reset}
			if text, fresh := weeklyText(q, now); text != tc.want || fresh != tc.fresh {
				t.Fatalf("notice=%q fresh=%v", text, fresh)
			}
		})
	}
	if text, _ := weeklyText(nil, now); text != "week --" {
		t.Fatal(text)
	}
	if text, _ := weeklyText(&accountpool.WeeklyUsage{}, now); text != "week --" {
		t.Fatal(text)
	}
}

func TestMainCompassShowsTinyWeeklyNotices(t *testing.T) {
	codex, claude := codexEngine(), claudeEngine()
	zero, high := 0, 95
	codex.Weekly = &accountpool.WeeklyUsage{Used: &zero, FetchedAt: time.Now().Format(time.RFC3339)}
	claude.Weekly = &accountpool.WeeklyUsage{Used: &high, FetchedAt: time.Now().Format(time.RFC3339)}
	for _, utf8 := range []bool{false, true} {
		p := newPicker([]Engine{codex, claude, grokEngine()}, nil, terminalui.Caps{UTF8: utf8})
		view := ansiStrip(p.render())
		for _, want := range []string{"week 0% used", "week 95% used", "week --"} {
			if !strings.Contains(view, want) {
				t.Fatalf("notice %q missing:\n%s", want, view)
			}
		}
		p = newPicker([]Engine{codex}, nil, terminalui.Caps{UTF8: utf8})
		if view := ansiStrip(p.render()); !strings.Contains(view, "week 0% used") {
			t.Fatal("single-engine notice missing", view)
		}
	}
}

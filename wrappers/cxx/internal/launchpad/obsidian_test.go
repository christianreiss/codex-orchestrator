package launchpad

import (
	"fmt"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func TestObsidianFitsViewportAndKeepsSelection(t *testing.T) {
	for _, size := range [][2]int{{160, 48}, {120, 36}, {80, 24}, {60, 18}, {30, 10}, {20, 8}} {
		for _, caps := range []terminalui.Caps{{IsTTY: true, UTF8: true}, {IsTTY: true, UTF8: true, NoColor: true}, terminalui.MinimalCaps(terminalui.Caps{})} {
			for n := 1; n <= 3; n++ {
				for _, key := range []string{"", "left", "right", "down"} {
					t.Run(fmt.Sprintf("%dx%d/utf8=%v/n=%d/%s", size[0], size[1], caps.UTF8, n, key), func(t *testing.T) {
						engines := []Engine{codexEngine(), claudeEngine(), grokEngine()}[:n]
						for i := range engines {
							for j := 0; j < 25; j++ {
								engines[i].Models = append(engines[i].Models, Model{ID: fmt.Sprintf("model-%02d-界界-e\u0301-long-catalog-name", j), Efforts: []string{"low", "medium", "high", "xhigh", "max", "ultra"}})
							}
						}
						p := newPicker(engines, nil, caps)
						p.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
						if key != "" {
							press(t, p, key)
						}
						if p.stage == stageGrid {
							for i := 0; i < 20; i++ {
								press(t, p, "down")
							}
							press(t, p, "right")
						}
						for frame := 0; frame < 7; frame++ {
							p.Update(frameMsg{gen: p.gen})
							out := p.render()
							lines := strings.Split(out, "\n")
							if len(lines) > size[1] {
								t.Fatalf("height=%d > %d\n%s", len(lines), size[1], ansi.Strip(out))
							}
							for _, line := range lines {
								if ansi.StringWidth(line) > size[0] {
									t.Fatalf("width=%d > %d: %q", ansi.StringWidth(line), size[0], line)
								}
							}
							if !strings.Contains(out, "enter") {
								t.Fatal("start action disappeared")
							}
							if p.stage == stageGrid {
								c := p.cursors[p.focus]
								id := p.current().Models[c.model].ID
								if !strings.Contains(out, id[:8]) {
									t.Fatalf("selected model is off screen: %q\n%s", id, ansi.Strip(out))
								}
								if !strings.Contains(out, "["+p.current().Models[c.model].Efforts[c.effort]+"]") {
									t.Fatalf("selected effort hidden during animation\n%s", ansi.Strip(out))
								}
							}
							if !caps.UTF8 && strings.ContainsAny(ansi.Strip(out), "╭│━●↑↓←→…") {
								t.Fatal("minimal renderer emitted decorative Unicode")
							}
						}
					})
				}
			}
		}
	}
}

func TestObsidianResizePreservesChoice(t *testing.T) {
	p := newPicker([]Engine{codexEngine(), claudeEngine(), grokEngine()}, nil, terminalui.Caps{IsTTY: true, UTF8: true})
	press(t, p, "right")
	press(t, p, "down")
	press(t, p, "right")
	c := p.cursors[p.focus]
	for _, size := range [][2]int{{160, 48}, {60, 18}, {80, 24}, {120, 36}} {
		p.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		p.render()
		if p.cursors[p.focus].model != c.model || p.cursors[p.focus].effort != c.effort {
			t.Fatal("resize changed choice")
		}
	}
	press(t, p, "enter")
	if p.result == nil || p.result.Model != p.engines[1].Models[c.model].ID {
		t.Fatal("launch did not preserve resized choice")
	}
	if _, cmd := p.Update(frameMsg{gen: p.gen}); cmd != nil {
		t.Fatal("completed picker kept ticking")
	}
}

func TestObsidianMotionPolicyAndImmediateInput(t *testing.T) {
	t.Setenv("CXX_REDUCED_MOTION", "1")
	p := newPicker([]Engine{codexEngine(), claudeEngine()}, nil, terminalui.Caps{IsTTY: true, UTF8: true})
	if p.Init() != nil {
		t.Fatal("reduced motion scheduled animation")
	}
	press(t, p, "left")
	if p.transition != 6 {
		t.Fatal("reduced motion did not render settled view")
	}
	t.Setenv("CXX_REDUCED_MOTION", "")
	for _, caps := range []terminalui.Caps{{IsTTY: true, UTF8: true, NoColor: true}, {IsTTY: true}, {IsTTY: true, Dumb: true, UTF8: true}} {
		p = newPicker([]Engine{codexEngine()}, nil, caps)
		if p.Init() != nil {
			t.Fatal("portable output scheduled animation")
		}
	}
	p = newPicker([]Engine{codexEngine(), claudeEngine()}, nil, terminalui.Caps{IsTTY: true, UTF8: true})
	if p.Init() == nil {
		t.Fatal("idle light missing")
	}
	press(t, p, "left")
	old := p.gen
	press(t, p, "down")
	press(t, p, "right")
	if _, cmd := p.Update(frameMsg{gen: old}); cmd != nil {
		t.Fatal("stale transition kept ticking")
	}
	press(t, p, "enter")
	if p.result == nil {
		t.Fatal("animation swallowed enter")
	}
	p = newPicker([]Engine{codexEngine()}, nil, terminalui.Caps{IsTTY: true, UTF8: true})
	p.Init()
	press(t, p, "ctrl+c")
	if _, cmd := p.Update(frameMsg{gen: p.gen}); cmd != nil {
		t.Fatal("cancelled picker kept ticking")
	}
}

func TestObsidianQuotaAndBlockedNotice(t *testing.T) {
	now := time.Now()
	used := 100
	codex := codexEngine()
	codex.Weekly = &accountpool.WeeklyUsage{Used: &used, FetchedAt: now.Format(time.RFC3339)}
	claude := claudeEngine()
	claude.Disabled = "not installed"
	p := newPicker([]Engine{codex, claude, grokEngine()}, nil, terminalui.Caps{IsTTY: true, UTF8: true})
	p.Update(tea.WindowSizeMsg{Width: 120, Height: 36})
	if got := p.quotaBar(0, 48); !strings.Contains(got, "week 100% used") || !strings.Contains(got, "━━━━━━━━━━━━") {
		t.Fatal(got)
	}
	codex.Weekly.FetchedAt = now.Add(-time.Hour).Format(time.RFC3339)
	if !strings.Contains(p.quotaBar(0, 48), "stale") {
		t.Fatal("staleness hidden")
	}
	codex.Weekly.ResetAt = now.Add(-time.Second).Format(time.RFC3339)
	if got := p.quotaBar(0, 48); strings.Contains(got, "━") {
		t.Fatal("expired quota rendered a bar")
	}
	if strings.Contains(p.quotaBar(2, 48), "week") {
		t.Fatal("Grok invented a quota")
	}
	press(t, p, "right")
	press(t, p, "enter")
	if p.result != nil || !strings.Contains(p.render(), "not installed") {
		t.Fatal("blocked choice not explained")
	}
}

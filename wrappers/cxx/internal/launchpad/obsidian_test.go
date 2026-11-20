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
			for n := 1; n <= 4; n++ {
				for _, key := range []string{"", "left", "right", "down", "up"} {
					t.Run(fmt.Sprintf("%dx%d/utf8=%v/n=%d/%s", size[0], size[1], caps.UTF8, n, key), func(t *testing.T) {
						engines := []Engine{codexEngine(), claudeEngine(), grokEngine(), kimiEngine()}[:n]
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

// loadDefault delivers the GET that entering a grid started.
func loadDefault(p *picker, value FleetDefault) {
	p.Update(fleetMsg{engine: value.Engine, generation: p.fleet[value.Engine].generation, value: value})
}

func TestFleetDefaultKeyIsAnActionChip(t *testing.T) {
	rich, minimal := terminalui.Caps{IsTTY: true, UTF8: true}, terminalui.MinimalCaps(terminalui.Caps{})
	for _, tc := range []struct {
		caps  terminalui.Caps
		w, h  int
		label string
	}{
		{rich, 120, 36, " d  set fleet default"},
		{rich, 80, 24, " d  set fleet default"},
		{rich, 72, 22, " d  set fleet default"},
		{rich, 60, 12, "d fleet default"},
		{minimal, 80, 24, " d  set fleet default"},
		{minimal, 20, 8, " d "},
	} {
		t.Run(fmt.Sprintf("%dx%d/utf8=%v", tc.w, tc.h, tc.caps.UTF8), func(t *testing.T) {
			p := newPicker([]Engine{codexEngine(), claudeEngine()}, nil, tc.caps)
			p.defaults = &defaultsFake{}
			p.Update(tea.WindowSizeMsg{Width: tc.w, Height: tc.h})
			if strings.Contains(ansi.Strip(p.render()), "fleet default") {
				t.Fatal("the compass offers d")
			}
			press(t, p, "left")
			lines := strings.Split(ansi.Strip(p.render()), "\n")
			row := -1
			for i, line := range lines {
				if strings.Contains(line, "enter") {
					row = i
				}
			}
			if row < 0 || !strings.Contains(lines[row], tc.label) || strings.Index(lines[row], tc.label) > strings.LastIndex(lines[row], "q") {
				t.Fatalf("d is not a chip between the launch keys and quit:\n%s", strings.Join(lines, "\n"))
			}
			for _, line := range lines[row+1:] {
				if strings.Contains(line, "set fleet default") || strings.Contains(line, "Set as fleet default") || strings.Contains(line, "d fleet default") {
					t.Fatalf("d hint is still on the navigation row: %q", line)
				}
			}
		})
	}
}

func TestFleetDefaultMarkedAwayFromCursor(t *testing.T) {
	for _, tc := range []struct {
		caps terminalui.Caps
		w, h int
		star string
	}{
		{terminalui.Caps{IsTTY: true, UTF8: true}, 120, 36, "★"},
		{terminalui.Caps{IsTTY: true, UTF8: true, NoColor: true}, 80, 24, "★"}, // never colour alone
		{terminalui.Caps{IsTTY: true, UTF8: true}, 72, 22, "★"},
		{terminalui.MinimalCaps(terminalui.Caps{}), 80, 24, "*"},
	} {
		t.Run(fmt.Sprintf("%dx%d/utf8=%v/nocolor=%v", tc.w, tc.h, tc.caps.UTF8, tc.caps.NoColor), func(t *testing.T) {
			p := newPicker([]Engine{codexEngine(), claudeEngine()}, nil, tc.caps)
			p.defaults = &defaultsFake{}
			p.Update(tea.WindowSizeMsg{Width: tc.w, Height: tc.h})
			press(t, p, "left")
			loadDefault(p, FleetDefault{Engine: "codex", Model: "gpt-6.1-sol", Effort: "high"})
			find := func(view, needle string) string {
				for _, line := range strings.Split(view, "\n") {
					if strings.Contains(line, needle) {
						return line
					}
				}
				t.Fatalf("%q missing:\n%s", needle, view)
				return ""
			}
			// Cursor on gpt-6-astra/medium: the default row is marked anyway, the
			// cursor row and the cursor model's efforts are not.
			view := ansi.Strip(p.render())
			if !strings.Contains(view, "gpt-6.1-sol "+tc.star) || strings.Contains(find(view, "gpt-6-astra"), tc.star) {
				t.Fatalf("default model not marked away from the cursor:\n%s", view)
			}
			if strings.Contains(find(view, "[medium]"), tc.star) {
				t.Fatalf("marked an effort of a model that is not the fleet default:\n%s", view)
			}
			// The card names the pair; ★ is explained in words, in the card or,
			// on a narrow card, on the navigation row.
			if !strings.Contains(view, "gpt-6.1-sol "+p.glyphs().dot+" high") || !strings.Contains(view, tc.star+" fleet default") {
				t.Fatalf("pair or legend missing:\n%s", view)
			}
			// On the default model the default effort is marked beside the cursor,
			// and on the cursor once both match.
			press(t, p, "up")
			if view = ansi.Strip(p.render()); !strings.Contains(find(view, "[medium]"), " high"+tc.star) {
				t.Fatalf("default effort not marked:\n%s", view)
			}
			press(t, p, "right")
			if view = ansi.Strip(p.render()); !strings.Contains(view, "[high]"+tc.star) || !p.isFleetDefault() {
				t.Fatalf("selected default effort not marked:\n%s", view)
			}
		})
	}
}

func TestHubCardsShowKnownFleetDefaults(t *testing.T) {
	for _, tc := range []struct {
		caps       terminalui.Caps
		w, h       int
		codex      string
		needLegend bool
	}{
		{terminalui.Caps{IsTTY: true, UTF8: true}, 120, 36, "★ fleet default  gpt-6.1-sol · high", false},
		{terminalui.Caps{IsTTY: true, UTF8: true}, 80, 24, "★ gpt-6.1-sol · high", true},
		{terminalui.Caps{IsTTY: true, UTF8: true}, 72, 22, "★ fleet default  gpt-6.1-sol · high", false},
		{terminalui.MinimalCaps(terminalui.Caps{}), 80, 24, "* fleet default  gpt-6.1-sol - high", false},
	} {
		t.Run(fmt.Sprintf("%dx%d/utf8=%v", tc.w, tc.h, tc.caps.UTF8), func(t *testing.T) {
			p := newPicker([]Engine{codexEngine(), claudeEngine()}, nil, tc.caps)
			p.defaults = &defaultsFake{}
			p.Update(tea.WindowSizeMsg{Width: tc.w, Height: tc.h})
			star := p.glyphs().star
			if view := ansi.Strip(p.render()); strings.Contains(view, star+" ") {
				t.Fatalf("cold compass shows a default:\n%s", view)
			}
			// Visit both grids: Codex's default differs from its card choice,
			// Claude's matches it.
			press(t, p, "left")
			loadDefault(p, FleetDefault{Engine: "codex", Model: "gpt-6.1-sol", Effort: "high"})
			press(t, p, "esc", "right")
			loadDefault(p, FleetDefault{Engine: "claude", Model: "claude-opus-5-5", Effort: "high"})
			press(t, p, "esc", "left", "esc")
			if p.stage != stageHub || p.focus != 0 {
				t.Fatal("not back on the compass with Codex focused")
			}
			view := ansi.Strip(p.render())
			if !strings.Contains(view, tc.codex) || strings.Count(view, star+" fleet default") < 1 {
				t.Fatalf("hub defaults missing:\n%s", view)
			}
			legend := false
			for _, line := range strings.Split(view, "\n") {
				legend = legend || (strings.Contains(line, "engine") && strings.Contains(line, star+" fleet default"))
			}
			if legend != tc.needLegend {
				t.Fatalf("legend=%v, want %v:\n%s", legend, tc.needLegend, view)
			}
		})
	}
}

func TestMinimalLaunchpadStaysASCII(t *testing.T) {
	states := map[string]func(*picker){
		"hub": func(p *picker) {},
		"grid": func(p *picker) {
			press(t, p, "left")
			loadDefault(p, FleetDefault{Engine: "codex", Model: "gpt-6.1-sol", Effort: "high"})
		},
		"loading":     func(p *picker) { press(t, p, "left") },
		"saving":      func(p *picker) { press(t, p, "left"); p.saveFleet() },
		"unavailable": func(p *picker) { press(t, p, "left"); p.fleet["codex"].unavailable = true },
	}
	for name, setup := range states {
		for _, size := range [][2]int{{80, 24}, {60, 12}, {30, 10}, {20, 8}, {20, 5}} {
			p := newPicker([]Engine{codexEngine(), claudeEngine(), grokEngine()}, nil, terminalui.MinimalCaps(terminalui.Caps{}))
			p.defaults = &defaultsFake{}
			p.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
			setup(p)
			for _, r := range p.render() {
				if r > 127 {
					t.Fatalf("%s %v: non-ASCII %q in minimal output:\n%s", name, size, r, p.render())
				}
			}
		}
	}
}

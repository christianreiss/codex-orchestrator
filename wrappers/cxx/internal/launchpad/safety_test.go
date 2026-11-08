package launchpad

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func TestEmptyCatalogRemainsVisibleWithoutBlockingHealthyEngine(t *testing.T) {
	empty := Engine{Name: "codex", Disabled: "no current models enabled"}
	for _, engines := range [][]Engine{{empty}, {empty, claudeEngine()}, {empty, Engine{Name: "grok"}}} {
		for _, size := range [][2]int{{80, 8}, {20, 5}, {120, 36}} {
			p := newPicker(engines, nil, terminalui.Caps{IsTTY: true, UTF8: true})
			p.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
			keys := []string{"enter", "c"}
			if len(engines) == 1 {
				keys = append(keys, "down", "right")
			}
			for _, key := range keys {
				press(t, p, key)
				_ = p.render()
			}
			if p.result != nil {
				t.Fatal("empty catalog selected")
			}
			if len(engines) == 2 && len(engines[1].Models) > 0 {
				press(t, p, "esc", "right", "enter")
				if p.stage == stageGrid {
					press(t, p, "enter")
				}
				if p.result == nil || p.result.Engine != "claude" {
					t.Fatal("healthy engine cannot be selected")
				}
			}
		}
	}
}
func TestCompactFailureNoticeSurvivesEightRowViewport(t *testing.T) {
	e := codexEngine()
	e.Models[1].Unavailable = "Model unavailable; choose another model or retry sync"
	p := newPicker([]Engine{e}, nil, terminalui.Caps{IsTTY: true, UTF8: true})
	p.Update(tea.WindowSizeMsg{Width: 80, Height: 8})
	press(t, p, "enter")
	out := ansi.Strip(p.render())
	if !strings.Contains(out, e.Models[1].Unavailable) || !strings.Contains(out, "q") || !strings.Contains(out, "enter") {
		t.Fatalf("recovery clipped:\n%s", out)
	}
	if len(strings.Split(out, "\n")) > 8 {
		t.Fatalf("viewport overflow:\n%s", out)
	}
}

package launchpad

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func nodePosition(t *testing.T, view string) (int, int) {
	t.Helper()
	for row, line := range strings.Split(ansiStrip(view), "\n") {
		if index := strings.Index(line, "●"); index >= 0 {
			return row, ansi.StringWidth(line[:index])
		}
	}
	t.Fatalf("no centre node in view:\n%s", view)
	return 0, 0
}

func TestDirectionalGridsKeepCompassOriginDuringReveal(t *testing.T) {
	for _, key := range []string{"left", "right", "down"} {
		t.Run(key, func(t *testing.T) {
			p := newPicker([]Engine{codexEngine(), claudeEngine(), grokEngine()}, nil, terminalui.Caps{UTF8: true, IsTTY: true})
			p.Update(tea.WindowSizeMsg{Width: 240, Height: 40})
			row, col := nodePosition(t, p.render())
			press(t, p, key)
			for p.frame = 0; p.frame <= p.doneFrames(); p.frame++ {
				gotRow, gotCol := nodePosition(t, p.render())
				if gotRow != row || gotCol != col {
					t.Fatalf("frame %d: origin=(%d,%d), want (%d,%d)", p.frame, gotRow, gotCol, row, col)
				}
			}
		})
	}
}

func TestGridsExpandInSelectedDirection(t *testing.T) {
	for _, utf8 := range []bool{false, true} {
		for _, key := range []string{"left", "right", "down"} {
			t.Run(fmt.Sprintf("%s utf8=%v", key, utf8), func(t *testing.T) {
				p := newPicker([]Engine{codexEngine(), claudeEngine(), grokEngine()}, nil, terminalui.Caps{UTF8: utf8})
				press(t, p, key)
				lines := p.grid()
				for i := range lines {
					lines[i] = ansiStrip(lines[i])
				}
				e := p.current()
				g := p.glyphs()
				switch key {
				case "left":
					if !strings.HasSuffix(lines[0], e.Label()+" "+strings.Repeat(g.path, pathWidth)+" "+g.node) {
						t.Fatalf("left path faces wrong way: %s", lines[0])
					}
					selected := lines[p.cursors[p.focus].model+1]
					if strings.Index(selected, "medium") > strings.Index(selected, e.Model) || !strings.HasSuffix(selected, g.left+g.teeLeftOn) {
						t.Fatalf("left model/effort branch faces wrong way: %s", selected)
					}
				case "right":
					if lines[0] != g.node+" "+strings.Repeat(g.path, pathWidth)+" "+e.Label() {
						t.Fatalf("right path changed: %s", lines[0])
					}
					selected := lines[p.cursors[p.focus].model+1]
					if strings.Index(selected, "high") < strings.Index(selected, e.Model) || !strings.Contains(selected, g.teeOn+g.right) {
						t.Fatalf("right model/effort branch changed: %s", selected)
					}
				case "down":
					col := ansi.StringWidth(lines[0]) - 1
					for row := 1; row <= downPathHeight; row++ {
						if ansi.StringWidth(lines[row])-1 != col {
							t.Fatalf("down stem disconnected: %v", lines)
						}
					}
					if !strings.HasSuffix(lines[downPathHeight], g.down) || lines[downPathHeight+1] != e.Label() || !strings.Contains(lines[downPathHeight+2], e.Model) {
						t.Fatalf("down engine/models not below origin: %v", lines)
					}
				}
				for _, line := range lines {
					if ansi.StringWidth(line) > p.gridWidth() {
						t.Fatalf("line exceeds settled width: %s", line)
					}
				}
				t.Logf("settled grid:\n%s", strings.Join(lines, "\n"))
			})
		}
	}
}

func TestDownGridReservesHeightForStemAndScrolls(t *testing.T) {
	grok := grokEngine()
	for i := 0; i < 20; i++ {
		grok.Models = append(grok.Models, Model{ID: fmt.Sprintf("grok-model-%02d", i)})
	}
	p := newPicker([]Engine{codexEngine(), claudeEngine(), grok}, nil, terminalui.Caps{UTF8: true})
	p.Update(tea.WindowSizeMsg{Width: 240, Height: 20})
	press(t, p, "down")
	p.frame = p.doneFrames()
	for i := 0; i < 15; i++ {
		press(t, p, "down")
	}
	view := ansiStrip(p.render())
	if p.cursors[p.focus].offset == 0 || !strings.Contains(view, "grok-model-14") || !strings.Contains(view, "more") {
		t.Fatalf("down viewport did not follow cursor:\n%s", view)
	}
	if lines := len(strings.Split(view, "\n")); lines > p.height {
		t.Fatalf("down viewport has %d lines, terminal has %d", lines, p.height)
	}
}

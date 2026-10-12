package launchpad

import (
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

type stage int

const (
	// stageHub is the compass: engines around a centre, nothing chosen yet.
	stageHub stage = iota
	// stageGrid is one engine's model (↑↓) by effort (←→) grid.
	stageGrid
)

const (
	frameInterval = 16 * time.Millisecond
	pathFrames    = 8
	branchFrames  = 4
)

// Compass slots, filled in screen order by the engines present.
var slotKeys = [][]string{{"left", "h"}, {"right", "l"}, {"down", "j"}}

type cursor struct {
	model, effort, offset int
}

type frameMsg struct{ gen int }

// picker is the Bubble Tea model. Update is pure so tests can drive it with
// key messages and inspect the outcome without a terminal.
type picker struct {
	engines []Engine
	cursors []cursor
	stage   stage
	focus   int

	animate bool
	gen     int
	frame   int // path and row reveal after entering the grid
	branch  int // effort strip reveal after a model change

	width, height int
	caps          terminalui.Caps
	notice        string

	result    *Selection
	cancelled bool
}

func newPicker(engines []Engine, last *Selection, caps terminalui.Caps) *picker {
	p := &picker{engines: engines, cursors: make([]cursor, len(engines)), caps: caps, animate: caps.IsTTY && !caps.Dumb}
	for i, e := range engines {
		p.cursors[i] = cursorFor(e)
		if last != nil && last.Engine == e.Name {
			p.focus = i
		}
	}
	if len(engines) == 1 {
		p.stage = stageGrid
	}
	p.frame, p.branch = p.doneFrames(), branchFrames
	return p
}

func cursorFor(e Engine) cursor {
	var c cursor
	for i, m := range e.Models {
		if m.ID == e.Model {
			c.model = i
			break
		}
	}
	m := e.Models[c.model]
	for i, effort := range m.Efforts {
		if effort == e.Effort {
			c.effort = i
		}
	}
	return c
}

func (p *picker) doneFrames() int { return pathFrames + len(p.current().Models) }

func (p *picker) current() Engine { return p.engines[p.focus] }

func (p *picker) Init() tea.Cmd {
	if p.stage == stageGrid {
		return p.restart(true)
	}
	return nil
}

// restart replays the reveal animation; path=false replays only the branch.
func (p *picker) restart(path bool) tea.Cmd {
	if !p.animate {
		return nil
	}
	if path {
		p.frame = 0
	}
	p.branch = 0
	p.gen++
	return p.tick()
}

func (p *picker) tick() tea.Cmd {
	gen := p.gen
	return tea.Tick(frameInterval, func(time.Time) tea.Msg { return frameMsg{gen: gen} })
}

func (p *picker) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		p.width, p.height = msg.Width, msg.Height
		return p, nil
	case frameMsg:
		if msg.gen != p.gen {
			return p, nil
		}
		if p.frame < p.doneFrames() {
			p.frame++
		}
		if p.branch < branchFrames {
			p.branch++
		}
		if p.frame < p.doneFrames() || p.branch < branchFrames {
			return p, p.tick()
		}
		return p, nil
	case tea.KeyPressMsg:
		return p.key(msg.String())
	}
	return p, nil
}

func (p *picker) key(k string) (tea.Model, tea.Cmd) {
	p.notice = ""
	switch k {
	case "ctrl+c", "q":
		return p.cancel()
	case "enter":
		return p.choose(ModeNew)
	case "c":
		return p.choose(ModeContinue)
	case "r":
		return p.choose(ModePick)
	}
	if p.stage == stageHub {
		if k == "esc" {
			return p.cancel()
		}
		for slot, keys := range slotKeys {
			if slot < len(p.engines) && (k == keys[0] || k == keys[1]) {
				return p.enter(slot)
			}
		}
		return p, nil
	}
	c := &p.cursors[p.focus]
	models := p.current().Models
	switch k {
	case "esc", "backspace":
		if len(p.engines) == 1 {
			return p.cancel()
		}
		p.stage = stageHub
		return p, nil
	case "up", "k":
		return p, p.moveModel(c, models, -1)
	case "down", "j":
		return p, p.moveModel(c, models, 1)
	case "left", "h":
		if c.effort > 0 {
			c.effort--
		}
	case "right", "l":
		if c.effort < len(models[c.model].Efforts)-1 {
			c.effort++
		}
	}
	return p, nil
}

func (p *picker) enter(slot int) (tea.Model, tea.Cmd) {
	p.focus = slot
	if reason := p.engines[slot].Disabled; reason != "" {
		p.notice = p.engines[slot].Label() + ": " + reason
		return p, nil
	}
	p.stage = stageGrid
	return p, p.restart(true)
}

// moveModel keeps the effort by name when the new model accepts it, and
// otherwise snaps to that model's default.
func (p *picker) moveModel(c *cursor, models []Model, delta int) tea.Cmd {
	next := c.model + delta
	if next < 0 || next >= len(models) {
		return nil
	}
	want := ""
	if efforts := models[c.model].Efforts; c.effort < len(efforts) {
		want = efforts[c.effort]
	}
	c.model = next
	c.effort = 0
	snapped := snapEffort(models[next], want)
	for i, effort := range models[next].Efforts {
		if effort == snapped {
			c.effort = i
		}
	}
	return p.restart(false)
}

func (p *picker) choose(mode Mode) (tea.Model, tea.Cmd) {
	e := p.current()
	if e.Disabled != "" {
		p.notice = e.Label() + ": " + e.Disabled
		return p, nil
	}
	if mode == ModePick && !e.CanPick() {
		p.notice = e.Label() + " has no session picker; c continues the latest session"
		return p, nil
	}
	c := p.cursors[p.focus]
	m := e.Models[c.model]
	s := Selection{Engine: e.Name, Model: m.ID, Mode: mode}
	if c.effort < len(m.Efforts) {
		s.Effort = m.Efforts[c.effort]
	}
	p.result = &s
	return p, tea.Quit
}

func (p *picker) cancel() (tea.Model, tea.Cmd) {
	p.cancelled = true
	return p, tea.Quit
}

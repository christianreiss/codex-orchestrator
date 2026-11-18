package launchpad

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	tea "charm.land/bubbletea/v2"
)

// FleetDefault is the server-confirmed effective engine default, independent
// of this host's overrides and the remembered launchpad selection.
type FleetDefault struct {
	Engine      string `json:"engine"`
	Model       string `json:"model"`
	Effort      string `json:"reasoning_effort"`
	StoredModel string `json:"stored_model"`
}

// DefaultsAPI keeps transport outside the picker. Ordinary navigation and
// launching work without it, including offline and on older servers.
type DefaultsAPI interface {
	Get(context.Context, string) (FleetDefault, error)
	Set(context.Context, Selection) (FleetDefault, error)
}

var ErrDefaultsUnavailable = errors.New("fleet defaults require a server update")
var ErrDefaultsRejected = errors.New("fleet default rejected")

type fleetState struct {
	value       *FleetDefault
	generation  int
	loading     bool
	unavailable bool
}

type fleetMsg struct {
	engine     string
	generation int
	value      FleetDefault
	err        error
	save       bool
	uncertain  bool
}

const defaultsTimeout = 8 * time.Second

func (p *picker) loadFleet() tea.Cmd {
	if p.defaults == nil || p.stage != stageGrid || p.current().Disabled != "" {
		return nil
	}
	engine := p.current().Name
	state := p.fleet[engine]
	if state == nil {
		state = &fleetState{}
		p.fleet[engine] = state
	}
	if state.loading || state.value != nil || state.unavailable {
		return nil
	}
	state.generation++
	state.loading = true
	gen, api, parent := state.generation, p.defaults, p.context
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(parent, defaultsTimeout)
		defer cancel()
		value, err := api.Get(ctx, engine)
		return fleetMsg{engine: engine, generation: gen, value: value, err: err}
	}
}

func (p *picker) saveFleet() tea.Cmd {
	if p.stage != stageGrid || p.defaults == nil || p.saving {
		return nil
	}
	e := p.current()
	if e.Disabled != "" || len(e.Models) == 0 {
		p.notice = "Fleet default unavailable for this engine"
		return nil
	}
	c := p.cursors[p.focus]
	m := e.Models[c.model]
	if m.ID == "" || m.Unavailable != "" {
		p.notice = "Choose an available model before setting the fleet default"
		return nil
	}
	s := Selection{Engine: e.Name, Model: m.ID}
	if c.effort < len(m.Efforts) {
		s.Effort = m.Efforts[c.effort]
	}
	if slices.Contains(m.SessionEfforts, s.Effort) {
		p.notice = s.Effort + " is session-only; choose a persistent effort for the fleet default"
		return nil
	}
	state := p.fleet[e.Name]
	if state == nil {
		state = &fleetState{}
		p.fleet[e.Name] = state
	}
	if state.unavailable {
		p.notice = ErrDefaultsUnavailable.Error()
		return nil
	}
	state.generation++ // Ignore any earlier GET that races this save.
	state.loading = false
	p.saving = true
	p.notice = "Saving fleet default..."
	gen, api, parent := state.generation, p.defaults, p.context
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(parent, defaultsTimeout)
		value, err := api.Set(ctx, s)
		cancel()
		msg := fleetMsg{engine: e.Name, generation: gen, value: value, err: err, save: true}
		if err == nil || errors.Is(err, ErrDefaultsRejected) || errors.Is(err, ErrDefaultsUnavailable) {
			return msg
		}
		// A lost reply does not mean the write failed. Read once, never retry
		// the POST automatically or claim success from a cached selection.
		readCtx, readCancel := context.WithTimeout(parent, defaultsTimeout)
		defer readCancel()
		confirmed, readErr := api.Get(readCtx, s.Engine)
		if readErr == nil && confirmed.Engine == s.Engine && (confirmed.Model == s.Model || confirmed.StoredModel == s.Model) && confirmed.Effort == s.Effort {
			msg.value, msg.err = confirmed, nil
		} else {
			msg.uncertain = true
		}
		return msg
	}
}

func (p *picker) acceptFleet(msg fleetMsg) {
	state := p.fleet[msg.engine]
	if state == nil || state.generation != msg.generation {
		return
	}
	state.loading = false
	if msg.save {
		p.saving = false
	}
	if errors.Is(msg.err, ErrDefaultsUnavailable) {
		state.unavailable = true
	}
	if msg.err != nil {
		if msg.uncertain {
			state.value = nil
		}
		if msg.engine == p.current().Name {
			p.notice = "Fleet default: " + msg.err.Error()
			if msg.uncertain {
				p.notice = "Fleet default save not confirmed; press d to retry or check Engines in admin"
			}
		}
		return
	}
	state.value = &msg.value
	if msg.save {
		p.notice = fmt.Sprintf("Fleet default saved: %s / %s", msg.value.Engine, msg.value.Model)
		if msg.value.Effort != "" {
			p.notice += " / " + msg.value.Effort
		}
		if msg.value.StoredModel != "" {
			p.notice += " (latest-family policy; stored " + msg.value.StoredModel + ")"
		}
	}
}

func (p *picker) isFleetDefault() bool {
	state := p.fleet[p.current().Name]
	if state == nil || state.value == nil || len(p.current().Models) == 0 {
		return false
	}
	c := p.cursors[p.focus]
	m := p.current().Models[c.model]
	effort := ""
	if c.effort < len(m.Efforts) {
		effort = m.Efforts[c.effort]
	}
	return m.ID == state.value.Model && effort == state.value.Effort
}

func (p *picker) defaultHint() string {
	if p.defaults == nil || p.stage != stageGrid {
		return ""
	}
	if p.saving {
		return "saving fleet default"
	}
	if state := p.fleet[p.current().Name]; state != nil {
		if state.unavailable {
			return "fleet default unavailable"
		}
		if state.loading {
			return "d fleet default (loading)"
		}
	}
	if p.width >= 40 {
		return "d Set as fleet default"
	}
	return "d fleet default"
}

func (p *picker) defaultSummary() string {
	if p.isFleetDefault() {
		return "Fleet default / "
	}
	return ""
}

func (p *picker) quitNotice() string {
	if p.saving {
		return "Fleet default save not confirmed; quitting does not undo a server-side save."
	}
	return ""
}

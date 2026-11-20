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

// savingNotice is shown while a save is in flight; the d key's own label
// already says so, so the rich footer does not repeat it.
const savingNotice = "Saving fleet default..."

// unavailableNotice is the one sentence for an older server without defaults.
const unavailableNotice = "Fleet defaults require a server update"

// loadFleet reads the focused engine's default when its grid opens.
func (p *picker) loadFleet() tea.Cmd {
	if p.stage != stageGrid {
		return nil
	}
	return p.fetchFleet(p.focus)
}

// prefetchFleet reads every shown engine's default when the compass opens,
// so each card can name it. The server has no batch read, so this is one
// concurrent GET per engine. Results land in the state the grid reads:
// entering a grid whose default is known or still in flight sends nothing,
// and a failure stays quiet until that grid opens and asks again. Like the
// grid load, it runs under the picker context, which Run cancels on exit.
func (p *picker) prefetchFleet() tea.Cmd {
	var cmds []tea.Cmd
	for i := range p.engines {
		cmds = append(cmds, p.fetchFleet(i))
	}
	return tea.Batch(cmds...)
}

func (p *picker) fetchFleet(i int) tea.Cmd {
	if p.defaults == nil || p.engines[i].Disabled != "" {
		return nil
	}
	engine := p.engines[i].Name
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
		p.notice = unavailableNotice
		return nil
	}
	state.generation++ // Ignore any earlier GET that races this save.
	state.loading = false
	p.saving = true
	p.notice = savingNotice
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
		// Only the open grid explains a failure; the compass stays quiet.
		if p.stage == stageGrid && msg.engine == p.current().Name {
			p.notice = "Fleet default: " + msg.err.Error()
			if errors.Is(msg.err, ErrDefaultsUnavailable) {
				p.notice = unavailableNotice
			}
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

// fleetValue is engine i's confirmed fleet default, or nil while unknown.
func (p *picker) fleetValue(i int) *FleetDefault {
	if i < 0 || i >= len(p.engines) {
		return nil
	}
	state := p.fleet[p.engines[i].Name]
	if state == nil || state.value == nil || state.value.Model == "" {
		return nil
	}
	return state.value
}

// defaultRow is the menu row holding engine i's fleet-default model, or -1
// when it is unknown or not on this host's menu.
func (p *picker) defaultRow(i int) int {
	d := p.fleetValue(i)
	if d == nil {
		return -1
	}
	for row, m := range p.engines[i].Models {
		if m.ID == d.Model {
			return row
		}
	}
	return -1
}

// defaultEffort is the fleet-default effort, but only on the row of the
// fleet-default model: the default is a pair, not an effort on its own.
func (p *picker) defaultEffort(i, row int) string {
	if row < 0 || row != p.defaultRow(i) {
		return ""
	}
	return p.fleetValue(i).Effort
}

// isDefaultPair reports whether engine i's cursor sits on the confirmed pair.
func (p *picker) isDefaultPair(i int) bool {
	row := p.defaultRow(i)
	c := p.cursors[i]
	if row < 0 || row != c.model {
		return false
	}
	m := p.engines[i].Models[row]
	effort := ""
	if c.effort < len(m.Efforts) {
		effort = m.Efforts[c.effort]
	}
	return effort == p.fleetValue(i).Effort
}

func (p *picker) isFleetDefault() bool { return p.isDefaultPair(p.focus) }

// defaultAction describes the d key in the grid: its label, a shorter label
// for narrow terminals, and whether pressing it can save right now. An empty
// label means the key is not offered.
func (p *picker) defaultAction() (label, short string, live bool) {
	e := p.current()
	if p.defaults == nil || p.stage != stageGrid || e.Disabled != "" || len(e.Models) == 0 {
		return "", "", false
	}
	if p.saving {
		label = "saving" + p.ellipsis()
		return label, label, false
	}
	// An old server cannot save; the card line says why, the key only dims.
	unavailable := p.fleet[e.Name] != nil && p.fleet[e.Name].unavailable
	return "set fleet default", "fleet default", !unavailable
}

func (p *picker) quitNotice() string {
	if p.saving {
		return "Fleet default save not confirmed; quitting does not undo a server-side save."
	}
	return ""
}

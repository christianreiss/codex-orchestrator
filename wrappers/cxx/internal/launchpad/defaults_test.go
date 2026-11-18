package launchpad

import (
	"context"
	"errors"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

type defaultsFake struct {
	value          FleetDefault
	getErr, setErr error
	gets, sets     int
	saved          Selection
}

func (f *defaultsFake) Get(context.Context, string) (FleetDefault, error) {
	f.gets++
	return f.value, f.getErr
}
func (f *defaultsFake) Set(_ context.Context, s Selection) (FleetDefault, error) {
	f.sets++
	f.saved = s
	if f.setErr == nil {
		f.value = FleetDefault{Engine: s.Engine, Model: s.Model, Effort: s.Effort}
	}
	return f.value, f.setErr
}

func defaultsPicker() (*picker, *defaultsFake) {
	p := newPicker([]Engine{codexEngine()}, nil, terminalui.Caps{})
	f := &defaultsFake{value: FleetDefault{Engine: "codex", Model: p.current().Model, Effort: p.current().Effort}}
	p.defaults = f
	return p, f
}

func TestFleetDefaultSaveStaysInPickerAndBlocksDuplicateOrLaunch(t *testing.T) {
	p, f := defaultsPicker()
	_, cmd := p.key("d")
	if cmd == nil || !p.saving {
		t.Fatal("save not started")
	}
	before := p.cursors[0]
	for _, key := range []string{"d", "enter", "c", "r", "down", "left", "esc"} {
		_, next := p.key(key)
		if next != nil || p.result != nil || p.cursors[0] != before {
			t.Fatalf("%s changed the in-flight save", key)
		}
	}
	p.Update(cmd())
	if p.saving || p.result != nil || f.sets != 1 || !p.isFleetDefault() || !strings.Contains(p.notice, "saved") {
		t.Fatalf("not a confirmed in-place save: %+v / %s", f, p.notice)
	}
	p.key("enter")
	if p.result == nil || p.result.Model != f.saved.Model {
		t.Fatal("normal launch no longer works")
	}
}

func TestFleetDefaultsSaveEveryEngineAndNoEffort(t *testing.T) {
	for _, e := range []Engine{codexEngine(), claudeEngine(), grokEngine(), kimiEngine()} {
		t.Run(e.Name, func(t *testing.T) {
			p := newPicker([]Engine{e}, nil, terminalui.Caps{})
			f := &defaultsFake{}
			p.defaults = f
			cmd := p.saveFleet()
			if cmd == nil {
				t.Fatal("missing save")
			}
			p.Update(cmd())
			if f.saved.Engine != e.Name || !p.isFleetDefault() {
				t.Fatalf("wrong target: %+v", f.saved)
			}
		})
	}
	p := newPicker([]Engine{{Name: "kimi", Model: "k3.1-pro", Models: []Model{{ID: "k3.1-pro"}}}}, nil, terminalui.Caps{})
	f := &defaultsFake{}
	p.defaults = f
	p.Update(p.saveFleet()())
	if f.saved.Effort != "" || !p.isFleetDefault() {
		t.Fatal("invented reasoning effort")
	}
}

func TestFleetDefaultsSessionOnlyAndUnavailableDoNotWrite(t *testing.T) {
	p, f := defaultsPicker()
	m := &p.engines[0].Models[p.cursors[0].model]
	m.SessionEfforts = []string{m.Efforts[p.cursors[0].effort]}
	if p.saveFleet() != nil || f.sets != 0 || !strings.Contains(p.notice, "session-only") {
		t.Fatal("session effort saved")
	}
	m.SessionEfforts = nil
	m.Unavailable = "upgrade native CLI"
	if p.saveFleet() != nil {
		t.Fatal("unavailable model saved")
	}
}

func TestFleetDefaultsReadFailureDoesNotPreventLaunch(t *testing.T) {
	for _, err := range []error{ErrDefaultsUnavailable, errors.New("offline")} {
		p, f := defaultsPicker()
		f.getErr = err
		p.Update(p.loadFleet()())
		if errors.Is(err, ErrDefaultsUnavailable) && p.saveFleet() != nil {
			t.Fatal("old server save enabled")
		}
		p.key("enter")
		if p.result == nil {
			t.Fatal("offline launch blocked")
		}
	}
}

func TestFleetDefaultsLostReplyReadsOnceAndNeverRepeatsWrite(t *testing.T) {
	for _, matches := range []bool{true, false} {
		p, f := defaultsPicker()
		f.setErr = errors.New("reply lost")
		if !matches {
			f.value.Model = "another-model"
		}
		p.Update(p.saveFleet()())
		if f.sets != 1 || f.gets != 1 || p.saving {
			t.Fatalf("bad reconciliation: %+v", f)
		}
		if matches && !p.isFleetDefault() {
			t.Fatal("matching readback not confirmed")
		}
		if !matches && !strings.Contains(p.notice, "not confirmed") {
			t.Fatal("false success")
		}
	}
}

func TestFleetDefaultsRejectAndStaleRead(t *testing.T) {
	p, f := defaultsPicker()
	old := p.loadFleet()
	f.setErr = ErrDefaultsRejected
	p.Update(p.saveFleet()())
	if f.gets != 0 || p.saving {
		t.Fatal("definite rejection reconciled")
	}
	p.Update(old())
	if p.isFleetDefault() {
		t.Fatal("stale GET overwrote rejection")
	}
}

func TestFleetDefaultsPolicyReplyAndQuit(t *testing.T) {
	p, _ := defaultsPicker()
	p.fleet["codex"] = &fleetState{generation: 1}
	p.saving = true
	p.Update(fleetMsg{engine: "codex", generation: 1, save: true, value: FleetDefault{Engine: "codex", Model: "new-astra", StoredModel: "old-astra", Effort: "high"}})
	if !strings.Contains(p.notice, "latest-family policy") || !strings.Contains(p.notice, "new-astra") {
		t.Fatal(p.notice)
	}
	p.saving = true
	_, cmd := p.key("q")
	if cmd == nil || !p.cancelled || !strings.Contains(p.quitNotice(), "not confirmed") {
		t.Fatal("quit lost pending outcome")
	}
}

func TestFleetDefaultsStatusFitsTerminalViews(t *testing.T) {
	for _, size := range [][2]int{{160, 48}, {80, 24}, {40, 12}, {30, 10}, {20, 8}, {20, 5}} {
		p, f := defaultsPicker()
		p.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		p.Update(p.loadFleet()())
		before := p.cursors[0]
		out := p.render()
		if !strings.Contains(out, "d ") {
			t.Fatalf("default action hidden at %v: %s", size, out)
		}
		if !strings.Contains(out, "fleet default") && !strings.Contains(out, "Fleet default") {
			t.Fatal("default mark hidden")
		}
		if f.sets != 0 || before.model != p.cursors[0].model || before.effort != p.cursors[0].effort {
			t.Fatal("render changed selection")
		}
		p.notice = "Fleet default save not confirmed; press d to retry or check Engines in admin"
		out = p.render()
		selected := p.current().Models[before.model]
		if !strings.Contains(out, modelName(selected.ID)) || !strings.Contains(out, "["+selected.Efforts[before.effort]+"]") {
			t.Fatalf("save/error notice hid selection at %v: %s", size, out)
		}
		p.saving = true
		out = p.render()
		if strings.Contains(out, "enter") || strings.Contains(out, "↑↓") || strings.Contains(out, "continue") || !strings.Contains(out, "q") {
			t.Fatalf("pending save advertised inactive keys at %v: %s", size, out)
		}
	}
}

func TestFleetDefaultTinyMatchTracksEffort(t *testing.T) {
	p, _ := defaultsPicker()
	p.Update(tea.WindowSizeMsg{Width: 20, Height: 5})
	p.Update(p.loadFleet()())
	marked := func() bool { return strings.Contains(p.render(), "\nfleet default") }
	if !marked() {
		t.Fatal("confirmed pair is not marked")
	}
	p.key("right")
	if marked() {
		t.Fatal("different effort is marked")
	}
	p.key("left")
	if !marked() {
		t.Fatal("restored effort is not marked")
	}
}

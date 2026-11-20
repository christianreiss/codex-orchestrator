package launchpad

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
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

func TestFleetDefaultChipStates(t *testing.T) {
	pal := terminalui.Palette{SurfaceActive: "\x1b[48;5;236m", Border: "\x1b[38;5;240m", Yellow: "\x1b[33m", Dim: "\x1b[2m", Reset: "\x1b[0m"}
	caps := terminalui.Caps{IsTTY: true, UTF8: true, Palette: pal}
	live, dimmed := pal.SurfaceActive+" d ", pal.Border+" d "
	for _, size := range [][2]int{{100, 30}, {72, 22}} {
		p := newPicker([]Engine{codexEngine()}, nil, caps)
		f := &defaultsFake{value: FleetDefault{Engine: "codex", Model: "gpt-6.1-sol", Effort: "high"}}
		p.defaults = f
		p.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		get := p.loadFleet()
		if out := p.render(); !strings.Contains(out, live) || !strings.Contains(ansi.Strip(out), "fleet default  loading…") {
			t.Fatalf("%v loading: d must stay usable and the card must say loading:\n%s", size, ansi.Strip(out))
		}
		p.Update(get())
		if out := ansi.Strip(p.render()); !strings.Contains(out, "fleet default  gpt-6.1-sol · high") || !strings.Contains(out, "set fleet default") {
			t.Fatalf("%v loaded default not shown:\n%s", size, out)
		}
		save := p.saveFleet()
		out := p.render()
		if plain := ansi.Strip(out); !strings.Contains(out, dimmed) || !strings.Contains(plain, "saving…") || strings.Count(plain, "aving") != 1 || strings.Contains(plain, "enter") {
			t.Fatalf("%v saving: want one dimmed d saving… and no launch keys:\n%s", size, plain)
		}
		p.Update(save())
		if out := ansi.Strip(p.render()); !strings.Contains(out, "Fleet default saved") || !strings.Contains(out, "enter") {
			t.Fatalf("%v save result missing:\n%s", size, out)
		}

		p = newPicker([]Engine{codexEngine()}, nil, caps)
		p.defaults = &defaultsFake{getErr: ErrDefaultsUnavailable}
		p.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		p.Update(p.loadFleet()())
		out = p.render()
		if plain := ansi.Strip(out); !strings.Contains(out, dimmed) || strings.Contains(out, live) || !strings.Contains(plain, "fleet default  unavailable") || !strings.Contains(plain, unavailableNotice) {
			t.Fatalf("%v unavailable: want a dimmed d and one explanation:\n%s", size, plain)
		}
	}
	// An engine without models offers no d at all.
	empty := newPicker([]Engine{{Name: "codex"}}, nil, caps)
	empty.defaults = &defaultsFake{}
	empty.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	if out := ansi.Strip(empty.render()); strings.Contains(out, "fleet default") || !strings.Contains(out, noModelsReason) {
		t.Fatalf("empty engine offered d:\n%s", out)
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

// perEngineDefaults answers each engine from a table and counts GETs. The
// compass prefetch calls it from several goroutines at once.
type perEngineDefaults struct {
	mu     sync.Mutex
	values map[string]FleetDefault
	errs   map[string]error
	gets   map[string]int
}

func (f *perEngineDefaults) Get(_ context.Context, engine string) (FleetDefault, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.gets == nil {
		f.gets = map[string]int{}
	}
	f.gets[engine]++
	return f.values[engine], f.errs[engine]
}

func (f *perEngineDefaults) Set(_ context.Context, s Selection) (FleetDefault, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	v := FleetDefault{Engine: s.Engine, Model: s.Model, Effort: s.Effort}
	f.values[s.Engine] = v
	return v, nil
}

func (f *perEngineDefaults) count(engine string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.gets[engine]
}

// drain runs a command as Bubble Tea does: a batch fans out concurrently
// (so -race sees the GETs overlap), and every result goes through Update.
func drain(p *picker, cmd tea.Cmd) {
	if cmd == nil {
		return
	}
	msg := cmd()
	batch, ok := msg.(tea.BatchMsg)
	if !ok {
		p.Update(msg)
		return
	}
	msgs := make([]tea.Msg, len(batch))
	var wg sync.WaitGroup
	for i, c := range batch {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if c != nil {
				msgs[i] = c()
			}
		}()
	}
	wg.Wait()
	for _, msg := range msgs {
		if msg != nil {
			p.Update(msg)
		}
	}
}

func TestHubPrefetchMarksEveryCardOnFreshOpen(t *testing.T) {
	t.Setenv("CXX_REDUCED_MOTION", "1")
	off := grokEngine()
	off.Name, off.Disabled = "kimi", "not installed"
	p := newPicker([]Engine{codexEngine(), claudeEngine(), grokEngine(), off}, nil, terminalui.Caps{IsTTY: true, UTF8: true})
	f := &perEngineDefaults{values: map[string]FleetDefault{
		"codex":  {Engine: "codex", Model: "gpt-6.1-sol", Effort: "high"},
		"claude": {Engine: "claude", Model: "claude-opus-5-5", Effort: "low"},
		"grok":   {Engine: "grok", Model: "grok-4.7", Effort: "xhigh"},
	}}
	p.defaults = f
	p.Update(tea.WindowSizeMsg{Width: 120, Height: 36})
	if view := ansi.Strip(p.render()); strings.Contains(view, "★") {
		t.Fatalf("a default is shown before it arrived:\n%s", view)
	}
	drain(p, p.Init())
	if f.count("codex") != 1 || f.count("claude") != 1 || f.count("grok") != 1 || f.count("kimi") != 0 {
		t.Fatalf("prefetch GETs = %v, want one per enabled engine", f.gets)
	}
	view := ansi.Strip(p.render())
	for _, pair := range []string{"gpt-6.1-sol · high", "claude-opus-5-5 · low", "grok-4.7 · xhigh"} {
		marked := false
		for _, line := range strings.Split(view, "\n") {
			marked = marked || (strings.Contains(line, "★") && strings.Contains(line, pair))
		}
		if !marked {
			t.Fatalf("fresh compass does not mark %q:\n%s", pair, view)
		}
	}
	if p.notice != "" {
		t.Fatalf("prefetch set a notice: %q", p.notice)
	}
	// The grid reuses the prefetched value: no second GET, marked at once.
	_, cmd := p.key("left")
	if cmd != nil || f.count("codex") != 1 || !strings.Contains(ansi.Strip(p.render()), "gpt-6.1-sol ★") {
		t.Fatalf("grid reloaded or lost the prefetched default (GETs %v):\n%s", f.gets, ansi.Strip(p.render()))
	}
	// A save still refreshes the card from its own reply.
	drain(p, p.saveFleet())
	press(t, p, "esc")
	if view := ansi.Strip(p.render()); f.count("codex") != 1 || !strings.Contains(view, "★ fleet default") || strings.Contains(view, "gpt-6.1-sol · high") {
		t.Fatalf("saved default not on the compass card (GETs %v):\n%s", f.gets, view)
	}
}

func TestHubPrefetchFailureStaysQuietUntilTheGrid(t *testing.T) {
	t.Setenv("CXX_REDUCED_MOTION", "1")
	p := newPicker([]Engine{codexEngine(), claudeEngine()}, nil, terminalui.Caps{IsTTY: true, UTF8: true})
	f := &perEngineDefaults{values: map[string]FleetDefault{}, errs: map[string]error{
		"codex":  ErrDefaultsUnavailable,
		"claude": errors.New("fleet connection failed or timed out"),
	}}
	p.defaults = f
	p.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	drain(p, p.Init())
	if view := ansi.Strip(p.render()); p.notice != "" || strings.Contains(strings.ToLower(view), "fleet default") {
		t.Fatalf("failed prefetch is not quiet on the compass (notice %q):\n%s", p.notice, view)
	}
	// An older server is known: the grid explains it once and does not ask again.
	_, cmd := p.key("left")
	if view := ansi.Strip(p.render()); cmd != nil || f.count("codex") != 1 || p.notice != unavailableNotice || !strings.Contains(view, "fleet default  unavailable") {
		t.Fatalf("unavailable grid (GETs %v, notice %q):\n%s", f.gets, p.notice, view)
	}
	// Any other failure is not fresh: the grid asks again and reports it.
	press(t, p, "esc")
	_, cmd = p.key("right")
	if view := ansi.Strip(p.render()); cmd == nil || !strings.Contains(view, "fleet default  loading") {
		t.Fatalf("failed default not reloaded by its grid:\n%s", view)
	}
	drain(p, cmd)
	if f.count("claude") != 2 || !strings.Contains(p.notice, "fleet connection failed") {
		t.Fatalf("grid retry: GETs %v, notice %q", f.gets, p.notice)
	}
}

// blockingDefaults holds every GET until its context ends.
type blockingDefaults struct{ started, stopped chan string }

func (b blockingDefaults) Get(ctx context.Context, engine string) (FleetDefault, error) {
	b.started <- engine
	<-ctx.Done()
	b.stopped <- engine
	return FleetDefault{}, ctx.Err()
}

func (blockingDefaults) Set(context.Context, Selection) (FleetDefault, error) {
	return FleetDefault{}, errors.New("unused")
}

func TestSlowPrefetchNeitherBlocksLaunchNorOutlivesRun(t *testing.T) {
	t.Setenv("CXX_REDUCED_MOTION", "1")
	for _, key := range []string{"\r", "q"} {
		b := blockingDefaults{started: make(chan string, 2), stopped: make(chan string, 2)}
		in, keys := io.Pipe()
		type outcome struct {
			s   Selection
			err error
		}
		done := make(chan outcome, 1)
		go func() {
			s, err := Run(context.Background(), in, io.Discard, []Engine{codexEngine(), claudeEngine()}, nil, terminalui.Caps{}, b)
			done <- outcome{s, err}
		}()
		for range 2 {
			select {
			case <-b.started:
			case <-time.After(5 * time.Second):
				t.Fatal("compass prefetch never started")
			}
		}
		if _, err := keys.Write([]byte(key)); err != nil {
			t.Fatal(err)
		}
		var got outcome
		select {
		case got = <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("key %q waited for the prefetch", key)
		}
		keys.Close()
		if key == "q" && !errors.Is(got.err, ErrCancelled) {
			t.Fatalf("quit: %v", got.err)
		}
		if key == "\r" && (got.err != nil || got.s.Engine != "codex" || got.s.Mode != ModeNew) {
			t.Fatalf("launch: %+v, %v", got.s, got.err)
		}
		for range 2 {
			select {
			case <-b.stopped:
			case <-time.After(2 * time.Second):
				t.Fatalf("key %q: a prefetch GET outlived Run", key)
			}
		}
	}
}

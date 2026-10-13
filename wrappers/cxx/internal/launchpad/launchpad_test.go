package launchpad

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func strp(s string) *string { return &s }

func codexEngine() Engine {
	return Engine{Name: "codex", Model: "gpt-6-astra", Effort: "medium", Models: []Model{
		{ID: "gpt-6.1-sol", Efforts: []string{"low", "medium", "high", "xhigh", "max", "ultra"}, DefaultEffort: "low"},
		{ID: "gpt-6-astra", Efforts: []string{"low", "medium", "high", "xhigh", "max", "ultra"}, DefaultEffort: "medium"},
		{ID: "gpt-6-luna", Efforts: []string{"low", "medium", "high", "xhigh", "max"}, DefaultEffort: "medium"},
	}}
}

func claudeEngine() Engine {
	return Engine{Name: "claude", Model: "claude-opus-5-5", Effort: "high", Models: []Model{
		{ID: "claude-opus-5-5", Efforts: []string{"low", "medium", "high", "xhigh", "max"}, DefaultEffort: "medium"},
		{ID: "claude-haiku-4-5-20251001"},
	}}
}

func grokEngine() Engine {
	return Engine{Name: "grok", Model: "grok-4.7", Effort: "high", Models: []Model{
		{ID: "grok-4.7", Efforts: []string{"low", "medium", "high", "xhigh"}, DefaultEffort: "high"},
	}}
}

func press(t *testing.T, p *picker, keys ...string) {
	t.Helper()
	for _, k := range keys {
		var msg tea.KeyPressMsg
		switch k {
		case "left":
			msg = tea.KeyPressMsg{Code: tea.KeyLeft}
		case "right":
			msg = tea.KeyPressMsg{Code: tea.KeyRight}
		case "up":
			msg = tea.KeyPressMsg{Code: tea.KeyUp}
		case "down":
			msg = tea.KeyPressMsg{Code: tea.KeyDown}
		case "enter":
			msg = tea.KeyPressMsg{Code: tea.KeyEnter}
		case "esc":
			msg = tea.KeyPressMsg{Code: tea.KeyEscape}
		default:
			msg = tea.KeyPressMsg{Code: rune(k[0]), Text: k}
		}
		if got := msg.String(); got != k {
			t.Fatalf("key %q renders as %q", k, got)
		}
		p.Update(msg)
	}
}

func TestHubDirectionsSelectEngines(t *testing.T) {
	cases := []struct {
		key, want string
	}{{"left", "codex"}, {"right", "claude"}, {"down", "grok"}}
	for _, tc := range cases {
		p := newPicker([]Engine{codexEngine(), claudeEngine(), grokEngine()}, nil, terminalui.Caps{})
		press(t, p, tc.key, "enter")
		if p.result == nil || p.result.Engine != tc.want || p.result.Mode != ModeNew {
			t.Fatalf("%s: result = %+v, want %s new", tc.key, p.result, tc.want)
		}
	}
}

func TestTwoEnginesHaveNoDownSlot(t *testing.T) {
	p := newPicker([]Engine{codexEngine(), claudeEngine()}, nil, terminalui.Caps{})
	press(t, p, "down")
	if p.stage != stageHub {
		t.Fatalf("down entered stage %v with two engines", p.stage)
	}
}

func TestEnterAtCentreLaunchesLastEngine(t *testing.T) {
	last := &Selection{Engine: "claude"}
	p := newPicker([]Engine{codexEngine(), claudeEngine()}, last, terminalui.Caps{})
	press(t, p, "enter")
	want := Selection{Engine: "claude", Model: "claude-opus-5-5", Effort: "high", Mode: ModeNew}
	if p.result == nil || *p.result != want {
		t.Fatalf("result = %+v, want %+v", p.result, want)
	}
}

func TestSingleEngineStartsInGrid(t *testing.T) {
	p := newPicker([]Engine{codexEngine()}, nil, terminalui.Caps{})
	if p.stage != stageGrid {
		t.Fatalf("stage = %v, want grid", p.stage)
	}
	press(t, p, "up", "right", "right", "enter")
	want := Selection{Engine: "codex", Model: "gpt-6.1-sol", Effort: "xhigh", Mode: ModeNew}
	if p.result == nil || *p.result != want {
		t.Fatalf("result = %+v, want %+v", p.result, want)
	}
}

func TestModelChangeKeepsOrSnapsEffort(t *testing.T) {
	p := newPicker([]Engine{codexEngine()}, nil, terminalui.Caps{})
	// medium survives a move to gpt-6-luna.
	press(t, p, "down", "enter")
	if p.result.Effort != "medium" {
		t.Fatalf("effort = %q, want medium kept", p.result.Effort)
	}
	// ultra does not exist on gpt-6-luna: snap to its default.
	p = newPicker([]Engine{codexEngine()}, nil, terminalui.Caps{})
	press(t, p, "right", "right", "right", "right", "down", "enter")
	if p.result.Model != "gpt-6-luna" || p.result.Effort != "medium" {
		t.Fatalf("result = %+v, want gpt-6-luna snapped to medium", p.result)
	}
}

func TestEffortClampsAtEnds(t *testing.T) {
	p := newPicker([]Engine{grokEngine()}, nil, terminalui.Caps{})
	press(t, p, "right", "right", "right", "enter")
	if p.result.Effort != "xhigh" {
		t.Fatalf("effort = %q, want clamp at xhigh", p.result.Effort)
	}
}

func TestModelWithoutEffortsLaunchesWithoutEffort(t *testing.T) {
	p := newPicker([]Engine{claudeEngine()}, nil, terminalui.Caps{})
	press(t, p, "down", "right", "enter")
	if p.result.Model != "claude-haiku-4-5-20251001" || p.result.Effort != "" {
		t.Fatalf("result = %+v, want haiku without effort", p.result)
	}
}

func TestEscapeReturnsToHubThenCancels(t *testing.T) {
	p := newPicker([]Engine{codexEngine(), claudeEngine()}, nil, terminalui.Caps{})
	press(t, p, "right", "esc")
	if p.stage != stageHub || p.cancelled {
		t.Fatalf("esc in grid: stage=%v cancelled=%v", p.stage, p.cancelled)
	}
	press(t, p, "esc")
	if !p.cancelled {
		t.Fatal("esc at hub must cancel")
	}
	single := newPicker([]Engine{codexEngine()}, nil, terminalui.Caps{})
	press(t, single, "esc")
	if !single.cancelled {
		t.Fatal("esc with one engine must cancel")
	}
}

func TestContinueAndPickModes(t *testing.T) {
	p := newPicker([]Engine{claudeEngine()}, nil, terminalui.Caps{})
	press(t, p, "c")
	if p.result == nil || p.result.Mode != ModeContinue {
		t.Fatalf("c: result = %+v", p.result)
	}
	p = newPicker([]Engine{claudeEngine()}, nil, terminalui.Caps{})
	press(t, p, "r")
	if p.result == nil || p.result.Mode != ModePick {
		t.Fatalf("r: result = %+v", p.result)
	}
	g := newPicker([]Engine{grokEngine()}, nil, terminalui.Caps{})
	press(t, g, "r")
	if g.result != nil || !strings.Contains(g.notice, "no session picker") {
		t.Fatalf("grok r: result=%+v notice=%q", g.result, g.notice)
	}
}

func TestDisabledEngineCannotLaunch(t *testing.T) {
	claude := claudeEngine()
	claude.Disabled = "not installed"
	p := newPicker([]Engine{codexEngine(), claude}, nil, terminalui.Caps{})
	press(t, p, "right")
	if p.stage != stageHub || !strings.Contains(p.notice, "not installed") {
		t.Fatalf("stage=%v notice=%q", p.stage, p.notice)
	}
	press(t, p, "enter")
	if p.result != nil {
		t.Fatalf("disabled engine launched: %+v", p.result)
	}
}

func TestAnimationFramesComplete(t *testing.T) {
	p := newPicker([]Engine{codexEngine(), claudeEngine()}, nil, terminalui.Caps{IsTTY: true, UTF8: true})
	p.Update(tea.KeyPressMsg{Code: tea.KeyLeft})
	if p.frame != 0 {
		t.Fatalf("frame = %d after entering grid, want 0", p.frame)
	}
	for i := 0; i < 100 && (p.frame < p.doneFrames() || p.branch < branchFrames); i++ {
		p.Update(frameMsg{gen: p.gen})
	}
	if p.frame != p.doneFrames() || p.branch != branchFrames {
		t.Fatalf("animation stuck at frame=%d branch=%d", p.frame, p.branch)
	}
	stale := p.gen - 1
	if _, cmd := p.Update(frameMsg{gen: stale}); cmd != nil {
		t.Fatal("stale frame must not keep ticking")
	}
}

func TestViewRendersAllLayouts(t *testing.T) {
	caps := terminalui.Caps{UTF8: true}
	for n := 1; n <= 3; n++ {
		engines := []Engine{codexEngine(), claudeEngine(), grokEngine()}[:n]
		p := newPicker(engines, nil, caps)
		out := ansiStrip(p.View().Content)
		for _, e := range engines {
			if !strings.Contains(out, e.Label()) {
				t.Fatalf("%d engines: view lacks %s:\n%s", n, e.Label(), out)
			}
		}
		if n == 3 && !strings.Contains(out, "▼") {
			t.Fatalf("three engines need the down arm:\n%s", out)
		}
	}
	p := newPicker([]Engine{claudeEngine()}, nil, caps)
	out := ansiStrip(p.View().Content)
	if !strings.Contains(out, "❰high❱") || !strings.Contains(out, "claude-haiku-4-5-20251001") {
		t.Fatalf("grid view missing effort strip or models:\n%s", out)
	}
	ascii := newPicker([]Engine{claudeEngine()}, nil, terminalui.Caps{})
	if out := ansiStrip(ascii.View().Content); !strings.Contains(out, "[high]") || strings.ContainsAny(out, "❰━●") {
		t.Fatalf("ascii view must not use unicode glyphs:\n%s", out)
	}
}

func ansiStrip(s string) string { return terminalui.StripANSI(s) }

func TestNativeArgs(t *testing.T) {
	cases := []struct {
		in   Selection
		want []string
	}{
		{Selection{Engine: "codex", Model: "gpt-6-astra", Effort: "high"}, []string{"-m", "gpt-6-astra", "--config", "model_reasoning_effort=high"}},
		{Selection{Engine: "codex", Model: "gpt-6-astra", Effort: "high", Mode: ModeContinue}, []string{"-m", "gpt-6-astra", "--config", "model_reasoning_effort=high", "resume", "--last"}},
		{Selection{Engine: "codex", Mode: ModePick}, []string{"resume"}},
		{Selection{Engine: "claude", Model: "claude-opus-5-5", Effort: "max"}, []string{"--model", "claude-opus-5-5", "--effort", "max"}},
		{Selection{Engine: "claude", Model: "claude-opus-5-5", Mode: ModeContinue}, []string{"--model", "claude-opus-5-5", "--continue"}},
		{Selection{Engine: "claude", Model: "claude-opus-5-5", Mode: ModePick}, []string{"--model", "claude-opus-5-5", "--resume"}},
		{Selection{Engine: "grok", Model: "grok-4.7", Effort: "xhigh", Mode: ModeContinue}, []string{"--model", "grok-4.7", "--reasoning-effort", "xhigh", "--continue"}},
	}
	for _, tc := range cases {
		if got := NativeArgs(tc.in); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("NativeArgs(%+v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func signed(engines []string, catalog *config.ModelCatalog) *config.Config {
	cfg := &config.Config{}
	cfg.Host.EnginesList = engines
	cfg.EngineOptions.ModelCatalog = catalog
	return cfg
}

func TestDiscoverUsesCatalogAndStartCursor(t *testing.T) {
	catalog := &config.ModelCatalog{DefaultModel: "claude-sonnet-5", Models: []config.ModelCatalogEntry{
		{Model: "claude-opus-5-5", Efforts: []string{"low", "medium", "high", "xhigh"}, SessionEfforts: []string{"max"}, DefaultEffort: strp("medium")},
		{Model: "claude-sonnet-5", Efforts: []string{"low", "medium", "high", "xhigh"}, SessionEfforts: []string{"max"}, DefaultEffort: strp("high")},
	}}
	src := Sources{
		Load: func(engine string) (*config.Config, error) {
			if engine != "claude" {
				return nil, errors.New("absent")
			}
			return signed([]string{"claude"}, catalog), nil
		},
		Installed: func(string) bool { return true },
		Local:     func(string) (string, string) { return "opus", "high" },
	}
	engines := Discover(src)
	if len(engines) != 1 || engines[0].Name != "claude" {
		t.Fatalf("engines = %+v", engines)
	}
	e := engines[0]
	if got := e.Models[0].Efforts; !reflect.DeepEqual(got, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Fatalf("efforts = %v, want persistent + session", got)
	}
	// The local "opus" alias is not a catalog ID: fall through to the default.
	if e.Model != "claude-sonnet-5" || e.Effort != "high" {
		t.Fatalf("start = %s/%s, want catalog default", e.Model, e.Effort)
	}

	src.Last = &Selection{Engine: "claude", Model: "claude-opus-5-5", Effort: "max"}
	e = Discover(src)[0]
	if e.Model != "claude-opus-5-5" || e.Effort != "max" {
		t.Fatalf("start = %s/%s, want last selection", e.Model, e.Effort)
	}
}

func TestDiscoverFiltersAndDisables(t *testing.T) {
	src := Sources{
		Load: func(engine string) (*config.Config, error) {
			cfg := signed([]string{"codex", "grok"}, nil)
			cfg.Host.FleetDisabledEngines = []string{"grok"}
			if engine == "claude" {
				return nil, errors.New("no config")
			}
			return cfg, nil
		},
		Installed: func(engine string) bool { return engine != "codex" },
		Local: func(engine string) (string, string) {
			if engine == "codex" {
				return "gpt-6-astra", "high"
			}
			return "", ""
		},
	}
	engines := Discover(src)
	if len(engines) != 2 || engines[0].Name != "codex" || engines[1].Name != "grok" {
		t.Fatalf("engines = %+v", engines)
	}
	if engines[0].Disabled != "not installed" || engines[1].Disabled != "suspended fleet-wide" {
		t.Fatalf("disabled = %q / %q", engines[0].Disabled, engines[1].Disabled)
	}
	// Without a catalog the menu is the configured model plus generic efforts.
	if m := engines[0].Models; len(m) != 1 || m[0].ID != "gpt-6-astra" || engines[0].Effort != "high" {
		t.Fatalf("fallback menu = %+v effort=%s", m, engines[0].Effort)
	}
	if m := engines[1].Models; len(m) != 1 || m[0].ID != "" {
		t.Fatalf("grok fallback without local model = %+v", m)
	}
	if got := NativeArgs(Selection{Engine: "grok", Model: engines[1].Model}); len(got) != 0 {
		t.Fatalf("unknown model must not pass --model: %q", got)
	}
}

func TestStateRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "launchpad.json")
	if LoadLast(path) != nil {
		t.Fatal("missing state must load as nil")
	}
	want := Selection{Engine: "grok", Model: "grok-4.7", Effort: "high", Mode: ModeContinue}
	if err := SaveLast(path, want); err != nil {
		t.Fatal(err)
	}
	got := LoadLast(path)
	want.Mode = ModeNew
	if got == nil || *got != want {
		t.Fatalf("LoadLast = %+v, want %+v (mode is not remembered)", got, want)
	}
}

func TestReceipt(t *testing.T) {
	s := Selection{Engine: "claude", Model: "claude-opus-5-5", Effort: "high", Mode: ModeContinue}
	if got := Receipt(s, true); got != "Claude → claude-opus-5-5 · high · continue" {
		t.Fatalf("Receipt = %q", got)
	}
	if got := Receipt(Selection{Engine: "codex"}, false); got != "Codex -> configured model - new" {
		t.Fatalf("ascii Receipt = %q", got)
	}
}

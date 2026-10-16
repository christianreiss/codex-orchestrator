// Package launchpad is the bare-`cxx` picker: one keyboard-driven screen that
// chooses an engine, a model and a reasoning effort, then hands the native
// argv to the managed launch path. It never touches the network; everything it
// offers comes from signed host configs, local native settings and cached usage.
package launchpad

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeentry"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
)

// Engines in screen order: the first present engine sits left of the centre,
// the second right, the third below.
var engineOrder = []string{config.EngineCodex, config.EngineClaude, config.EngineGrok}

// Fallback efforts when a signed config predates model_catalog. The menu then
// holds only the configured model, so no per-model catalog is duplicated here.
var fallbackEfforts = map[string][]string{
	config.EngineCodex:  {"low", "medium", "high", "xhigh"},
	config.EngineClaude: {"low", "medium", "high", "xhigh", "max"},
	config.EngineGrok:   {"low", "medium", "high", "xhigh"},
}

// Model is one selectable model and the efforts it accepts.
type Model struct {
	ID            string
	Efforts       []string
	DefaultEffort string
}

// Engine is one launchable engine with its menu and starting cursor.
type Engine struct {
	Name   string
	Models []Model
	// Model and Effort are the starting cursor.
	Model  string
	Effort string
	// Disabled explains why the engine is shown but cannot launch.
	Disabled string
	Weekly   *accountpool.WeeklyUsage
}

// Label is the product name shown on screen.
func (e Engine) Label() string { return config.EngineLabel(e.Name) }

// CanPick reports whether the native CLI has an interactive session picker.
// Grok's bare --resume silently takes the most recent session instead.
func (e Engine) CanPick() bool { return e.Name != config.EngineGrok }

// Sources are the side effects Discover needs, injected for tests.
type Sources struct {
	// Load returns the verified signed config for engine, or an error when
	// the engine is not installed on this host.
	Load func(engine string) (*config.Config, error)
	// Installed reports whether the engine's native CLI can be launched.
	Installed func(engine string) bool
	// Local returns the model and effort the native settings already select.
	Local func(engine string) (model, effort string)
	// Quota reads the last verified weekly observation, without provider probes.
	Quota func(engine string, cfg *config.Config) *accountpool.WeeklyUsage
	// Last is the previous launchpad selection, if any.
	Last *Selection
}

// Discover lists the engines this host may launch, in screen order. An engine
// appears only when its own signed config loads and assigns it.
func Discover(src Sources) []Engine {
	var out []Engine
	for _, name := range engineOrder {
		cfg, err := src.Load(name)
		if err != nil || cfg == nil || !assigned(cfg, name) {
			continue
		}
		e := Engine{Name: name, Models: menu(name, cfg, src)}
		switch {
		case len(e.Models) == 0:
			e.Disabled = "no current models enabled"
		case cfg.EngineSuspended(name):
			e.Disabled = "suspended fleet-wide"
		case src.Installed != nil && !src.Installed(name):
			e.Disabled = "not installed"
		}
		e.Model, e.Effort = start(name, cfg, e.Models, src)
		if src.Quota != nil {
			e.Weekly = src.Quota(name, cfg)
		}
		out = append(out, e)
	}
	return out
}

func assigned(cfg *config.Config, engine string) bool {
	for _, candidate := range nativeentry.AssignedEngines(cfg) {
		if candidate == engine {
			return true
		}
	}
	return false
}

func menu(engine string, cfg *config.Config, src Sources) []Model {
	if cfg.EngineOptions.ModelPolicy != nil && cfg.EngineOptions.ModelPolicy.LatestOnly && (cfg.EngineOptions.ModelCatalog == nil || len(cfg.EngineOptions.ModelCatalog.Models) == 0) {
		return nil
	}
	if catalog := cfg.EngineOptions.ModelCatalog; catalog != nil && len(catalog.Models) > 0 {
		models := make([]Model, 0, len(catalog.Models))
		for _, entry := range catalog.Models {
			if strings.TrimSpace(entry.Model) == "" {
				continue
			}
			m := Model{ID: entry.Model}
			m.Efforts = append(append(m.Efforts, entry.Efforts...), entry.SessionEfforts...)
			if entry.DefaultEffort != nil {
				m.DefaultEffort = *entry.DefaultEffort
			}
			models = append(models, m)
		}
		if len(models) > 0 {
			return models
		}
	}
	model := overrideModel(engine, cfg)
	effort := overrideEffort(engine, cfg)
	if src.Local != nil {
		localModel, localEffort := src.Local(engine)
		if model == "" {
			model = localModel
		}
		if effort == "" {
			effort = localEffort
		}
	}
	// An empty ID means "whatever the native config selects": no --model flag.
	return []Model{{ID: model, Efforts: fallbackEfforts[engine], DefaultEffort: effort}}
}

// start picks the cursor: the last launchpad choice for this engine, then the
// admin override, then the native settings, then the catalog default.
func start(engine string, cfg *config.Config, models []Model, src Sources) (string, string) {
	if len(models) == 0 {
		return "", ""
	}
	var candidates [][2]string
	if last := src.Last; last != nil && last.Engine == engine {
		candidates = append(candidates, [2]string{last.Model, last.Effort})
	}
	candidates = append(candidates, [2]string{overrideModel(engine, cfg), overrideEffort(engine, cfg)})
	if src.Local != nil {
		model, effort := src.Local(engine)
		candidates = append(candidates, [2]string{model, effort})
	}
	if catalog := cfg.EngineOptions.ModelCatalog; catalog != nil {
		candidates = append(candidates, [2]string{catalog.DefaultModel, ""})
	}
	for _, c := range candidates {
		if policy := cfg.EngineOptions.ModelPolicy; policy != nil && policy.LatestOnly {
			if next := policy.Replacements[c[0]]; next != "" {
				c[0] = next
			}
		}
		if m, ok := findModel(models, c[0]); ok {
			return m.ID, snapEffort(m, c[1])
		}
	}
	return models[0].ID, snapEffort(models[0], "")
}

func overrideModel(engine string, cfg *config.Config) string {
	opts := cfg.EngineOptions
	switch engine {
	case config.EngineClaude:
		return deref(opts.ClaudeModelOverride)
	case config.EngineGrok:
		if v := deref(opts.GrokModelOverride); v != "" {
			return v
		}
	}
	return deref(opts.ModelOverride)
}

func overrideEffort(engine string, cfg *config.Config) string {
	opts := cfg.EngineOptions
	switch engine {
	case config.EngineClaude:
		// Claude's effort override travels through settings.json, which Local reads.
		return ""
	case config.EngineGrok:
		if v := deref(opts.GrokReasoningEffortOverride); v != "" {
			return v
		}
	}
	return deref(opts.ReasoningEffortOverride)
}

func deref(v *string) string {
	if v == nil {
		return ""
	}
	return strings.TrimSpace(*v)
}

func findModel(models []Model, id string) (Model, bool) {
	id = strings.TrimSpace(id)
	if id == "" {
		return Model{}, false
	}
	for _, m := range models {
		if m.ID == id {
			return m, true
		}
	}
	return Model{}, false
}

// snapEffort keeps want when the model accepts it, else falls back to the
// model's default, else to its first effort. A model without efforts has none.
func snapEffort(m Model, want string) string {
	if len(m.Efforts) == 0 {
		return ""
	}
	for _, candidate := range []string{want, m.DefaultEffort} {
		for _, effort := range m.Efforts {
			if candidate != "" && effort == candidate {
				return effort
			}
		}
	}
	return m.Efforts[0]
}

// LocalPreferences reads the model and effort the native settings select,
// the same user-scope files the boot card falls back to. Unreadable or
// malformed files yield empty values.
func LocalPreferences(engine string) (model, effort string) {
	root, err := sessionguard.Root(engine)
	if err != nil {
		return "", ""
	}
	switch engine {
	case config.EngineCodex:
		tree, err := toml.LoadFile(filepath.Join(root, "config.toml"))
		if err != nil {
			return "", ""
		}
		model, _ = tree.Get("model").(string)
		effort, _ = tree.Get("model_reasoning_effort").(string)
	case config.EngineClaude:
		raw, err := os.ReadFile(filepath.Join(root, "settings.json"))
		if err != nil {
			return "", ""
		}
		model, effort = claude.UserSettingsPreferences(raw, "")
	case config.EngineGrok:
		tree, err := toml.LoadFile(filepath.Join(root, "config.toml"))
		if err != nil {
			return "", ""
		}
		model, _ = tree.Get("models.default").(string)
		effort, _ = tree.Get("models.default_reasoning_effort").(string)
	}
	return strings.TrimSpace(model), strings.TrimSpace(effort)
}

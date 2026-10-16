// Package modelpolicy applies the signed fleet rule at the last native launch
// boundary. It never edits saved user preferences or running sessions.
package modelpolicy

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeargs"
	"github.com/pelletier/go-toml"
)

type OptionEnd func([]string, int) int

// Apply reads native preferences before applying CLI overrides. optionEnd is
// provided by Claude's native parser; Codex/Grok use the shared grammar.
func Apply(cfg *config.Config, args []string, home string, optionEnd OptionEnd, stderr io.Writer) ([]string, error) {
	if cfg == nil || cfg.EngineOptions.ModelPolicy == nil || !cfg.EngineOptions.ModelPolicy.LatestOnly {
		return args, nil
	}
	engine := cfg.Engine
	if optionEnd == nil {
		optionEnd = func(args []string, at int) int { return nativeargs.ValueEnd(engine, args, at) }
	}
	if engine != "claude" {
		command, _ := nativeargs.Command(engine, args)
		reserved := " login logout mcp app-server completion completions sandbox debug apply a cloud features help agents archive unarchive delete queue plugin exec-server migrate-rollouts clone cursor-worker dashboard doctor du disk-usage export inspect leader memory models sessions setup trace update usage version v worktree wrap install upgrade "
		if command != "" && strings.Contains(reserved, " "+command+" ") {
			return args, nil
		}
	}
	for i := 0; i < len(args) && args[i] != "--"; i++ {
		last := optionEnd(args, i)
		name, _ := option(engine, args, i, last)
		if name == "--help" || name == "-h" || name == "--version" || name == "-V" || engine == "claude" && name == "-v" {
			return args, nil
		}
		i = last
	}
	prefs, err := loadPreferences(engine, home, args, optionEnd)
	if err != nil {
		return nil, err
	}
	model, effort := text(prefs["model"]), text(prefs["effort"])
	explicitEffort := false
	opts := cfg.EngineOptions
	if opts.ModelOverride != nil && prefs["profile"] != true {
		model = *opts.ModelOverride
	}
	if engine == "claude" && opts.ClaudeModelOverride != nil {
		model = *opts.ClaudeModelOverride
	}
	if engine == "grok" && opts.GrokModelOverride != nil {
		model = *opts.GrokModelOverride
	}
	if opts.ReasoningEffortOverride != nil && !(engine == "codex" && prefs["profile"] == true) {
		effort = *opts.ReasoningEffortOverride
		explicitEffort = true
	}
	if engine == "grok" && opts.GrokReasoningEffortOverride != nil {
		effort = *opts.GrokReasoningEffortOverride
		explicitEffort = true
	}
	out := make([]string, 0, len(args)+4)
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			out = append(out, args[i:]...)
			break
		}
		end := optionEnd(args, i)
		name, value := option(engine, args, i, end)
		if name == "--model" {
			if strings.TrimSpace(value) == "" {
				return nil, fmt.Errorf("fleet model policy: --model requires a model ID")
			}
			model = value
		} else if name == "--effort" {
			effort = value
			explicitEffort = true
		} else if key, setting, ok := strings.Cut(value, "="); name == "--config" && ok && strings.TrimSpace(key) == "model" {
			model = unquote(setting)
		} else if key, setting, ok := strings.Cut(value, "="); name == "--config" && ok && strings.TrimSpace(key) == "model_reasoning_effort" {
			effort = unquote(setting)
		} else {
			out = append(out, args[i:end+1]...)
		}
		i = end
	}
	if model == "" && opts.ModelCatalog != nil {
		model = opts.ModelCatalog.DefaultModel
	}
	// Native Claude tier aliases retain their family; long context is a modifier.
	model = strings.TrimSpace(model)
	modifier := ""
	if engine == "claude" {
		if strings.HasSuffix(model, "[1m]") {
			model = strings.TrimSuffix(model, "[1m]")
			modifier = "[1m]"
		}
		for old, next := range opts.ModelPolicy.Replacements {
			if strings.HasPrefix(old, "claude-"+model+"-") {
				model = next
				break
			}
		}
	}
	next, ok := opts.ModelPolicy.Replacements[model]
	if !ok || next == "" {
		return nil, fmt.Errorf("fleet model policy: unsupported %s model %q", engine, model)
	}
	if slices.Contains(opts.ModelPolicy.DisabledModels, next) {
		return nil, fmt.Errorf("fleet model policy: model %s is disabled by administrator", next)
	}
	if next != model && stderr != nil {
		fmt.Fprintf(stderr, "cxx: current models policy: %s → %s\n", model, next)
	}
	if engine == "claude" && !explicitEffort {
		// Claude's per-model settings supersede the historical top-level key.
		if settings, ok := prefs["modelSettings"].(map[string]any); ok {
			for _, id := range []string{model, next} {
				if entry, ok := settings[id].(map[string]any); ok {
					effort = text(entry["effortLevel"])
					break
				}
			}
		}
	}
	if opts.ModelCatalog == nil {
		return nil, fmt.Errorf("fleet model policy: signed model catalog missing")
	}
	var entry *config.ModelCatalogEntry
	for i := range opts.ModelCatalog.Models {
		if opts.ModelCatalog.Models[i].Model == next {
			entry = &opts.ModelCatalog.Models[i]
			break
		}
	}
	if entry == nil {
		return nil, fmt.Errorf("fleet model policy: model %s unavailable", next)
	}
	if !slices.Contains(entry.Efforts, effort) && !slices.Contains(entry.SessionEfforts, effort) {
		effort = ""
		if entry.DefaultEffort != nil {
			effort = *entry.DefaultEffort
		}
	}
	prefix := []string{"--model", next + modifier}
	if effort != "" {
		if engine == "codex" {
			prefix = append(prefix, "--config", "model_reasoning_effort="+effort)
		} else if engine == "claude" {
			prefix = append(prefix, "--effort", effort)
		} else {
			prefix = append(prefix, "--reasoning-effort", effort)
		}
	}
	return append(prefix, out...), nil
}

func text(v any) string       { s, _ := v.(string); return strings.TrimSpace(s) }
func unquote(s string) string { return strings.Trim(strings.TrimSpace(s), "\"'") }
func option(engine string, args []string, at, end int) (string, string) {
	if engine != "claude" {
		name, value, _ := nativeargs.Option(engine, args, at)
		if engine == "grok" && name == "--reasoning-effort" {
			name = "--effort"
		}
		return name, value
	}
	name, value, inline := strings.Cut(args[at], "=")
	if !inline && end > at {
		value = args[at+1]
	}
	return name, value
}

func loadPreferences(engine, home string, args []string, end OptionEnd) (map[string]any, error) {
	result := map[string]any{}
	if engine == "claude" {
		raw, err := os.ReadFile(filepath.Join(home, "settings.json"))
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		if len(raw) > 0 && json.Unmarshal(raw, &result) != nil {
			return nil, fmt.Errorf("fleet model policy: invalid Claude settings")
		}
		for i := 0; i < len(args) && args[i] != "--"; i++ {
			last := end(args, i)
			name, value := option(engine, args, i, last)
			if name == "--settings" {
				var overlay map[string]any
				body := []byte(value)
				if !strings.HasPrefix(strings.TrimSpace(value), "{") {
					var err error
					body, err = os.ReadFile(value)
					if err != nil {
						return nil, err
					}
				}
				if err := json.Unmarshal(body, &overlay); err != nil {
					return nil, fmt.Errorf("fleet model policy: invalid --settings: %w", err)
				}
				for _, key := range []string{"model", "effortLevel", "modelSettings"} {
					if v, ok := overlay[key]; ok {
						result[key] = v
					}
				}
			}
			i = last
		}
		result["effort"] = result["effortLevel"]
		if settings, ok := result["modelSettings"].(map[string]any); ok {
			if entry, ok := settings[text(result["model"])].(map[string]any); ok {
				result["effort"] = entry["effortLevel"]
			}
		}
		return result, nil
	}
	raw, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if len(raw) == 0 {
		return result, nil
	}
	tree, err := toml.LoadBytes(raw)
	if err != nil {
		return nil, fmt.Errorf("fleet model policy: invalid %s config: %w", engine, err)
	}
	if engine == "grok" {
		result["model"] = tree.Get("models.default")
		result["effort"] = tree.Get("models.default_reasoning_effort")
		return result, nil
	}
	result["model"] = tree.Get("model")
	result["effort"] = tree.Get("model_reasoning_effort")
	profile := ""
	for i := 0; i < len(args) && args[i] != "--"; i++ {
		last := end(args, i)
		name, value := option(engine, args, i, last)
		if name == "--profile" {
			profile = value
		}
		i = last
	}
	if profile != "" {
		result["profile"] = true
		if strings.ContainsAny(profile, "/\\") || profile == "." || profile == ".." {
			return nil, fmt.Errorf("fleet model policy: invalid profile name")
		}
		if raw, err := os.ReadFile(filepath.Join(home, profile+".config.toml")); err == nil {
			t, err := toml.LoadBytes(raw)
			if err != nil {
				return nil, err
			}
			for _, key := range []string{"model", "model_reasoning_effort"} {
				if t.Has(key) {
					tree.Set(key, t.Get(key))
				}
			}
		} else if !os.IsNotExist(err) {
			return nil, err
		} else if t, ok := tree.GetPath([]string{"profiles", profile}).(*toml.Tree); ok {
			for _, key := range []string{"model", "model_reasoning_effort"} {
				if t.Has(key) {
					tree.Set(key, t.Get(key))
				}
			}
		} else if profiles, ok := tree.Get("profiles").([]*toml.Tree); ok {
			for _, p := range profiles {
				if text(p.Get("name")) == profile {
					for _, key := range []string{"model", "model_reasoning_effort"} {
						if p.Has(key) {
							tree.Set(key, p.Get(key))
						}
					}
					break
				}
			}
		}
		result["model"] = tree.Get("model")
		result["effort"] = tree.Get("model_reasoning_effort")
	}
	return result, nil
}

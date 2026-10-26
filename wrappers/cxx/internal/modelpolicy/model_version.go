package modelpolicy

import (
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeargs"
)

// SelectedModel reads the same native root/profile and CLI precedence as Apply,
// even when latest-only is off. It neither rewrites argv nor touches auth.
func SelectedModel(cfg *config.Config, args []string, home string) (string, error) {
	if cfg == nil || cfg.Engine != config.EngineCodex {
		return "", nil
	}
	engine := cfg.Engine
	command, _ := nativeargs.Command(engine, args)
	utilities := " login logout mcp app-server completion completions sandbox debug apply a cloud features help agents archive unarchive delete queue plugin exec-server migrate-rollouts migrate-nfs-db clone doctor update version "
	if command != "" && strings.Contains(utilities, " "+command+" ") {
		return "", nil
	}
	if nativeargs.Has(engine, args, "--help", "--version") {
		return "", nil
	}
	end := func(args []string, at int) int { return nativeargs.ValueEnd(engine, args, at) }
	prefs, err := loadPreferences(engine, home, args, end)
	if err != nil {
		return "", err
	}
	model := text(prefs["model"])
	if cfg.EngineOptions.ModelOverride != nil && prefs["profile"] != true {
		model = *cfg.EngineOptions.ModelOverride
	}
	var explicitModel *string
	for i := 0; i < len(args) && args[i] != "--"; i++ {
		name, value, last := nativeargs.Option(engine, args, i)
		if name == "--model" {
			selected := value
			explicitModel = &selected
		}
		if key, value, ok := strings.Cut(value, "="); name == "--config" && ok && (strings.TrimSpace(key) == "model" || prefs["profile_sidecar"] != true && strings.TrimSpace(key) == "profiles."+text(prefs["profile_name"])+".model") {
			model = unquote(value)
		}
		i = last
	}
	// Native --model is a CLI override, not another config entry. It wins
	// over root/profile/-c model values regardless of argument order.
	if explicitModel != nil {
		model = *explicitModel
	}
	if model == "" && cfg.EngineOptions.ModelCatalog != nil {
		model = cfg.EngineOptions.ModelCatalog.DefaultModel
	}
	model = strings.TrimSpace(model)
	if policy := cfg.EngineOptions.ModelPolicy; policy != nil && policy.LatestOnly {
		if next := policy.Replacements[model]; next != "" {
			model = next
		}
	}
	return model, nil
}

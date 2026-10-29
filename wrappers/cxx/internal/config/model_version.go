package config

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var nativeModelVersion = regexp.MustCompile(`\b(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?`)

// NativeVersionAtLeast accepts an observed native version, never a desired pin.
func NativeVersionAtLeast(observed, minimum string) bool {
	a, b := nativeModelVersion.FindStringSubmatch(observed), nativeModelVersion.FindStringSubmatch(minimum)
	if a == nil || b == nil {
		return false
	}
	for i := 1; i <= 3; i++ {
		av, ae := strconv.ParseUint(a[i], 10, 64)
		bv, be := strconv.ParseUint(b[i], 10, 64)
		if ae != nil || be != nil {
			return false
		}
		if av != bv {
			return av > bv
		}
	}
	return a[4] == "" || b[4] != ""
}

// legacyModelMinimums are frozen fallbacks for signed configs that predate
// model_catalog.min_cli_versions (servers before the fleet model registry).
// Never add a model here: new floors travel only in the signed catalog.
var legacyModelMinimums = map[string]map[string]string{
	EngineCodex: {"gpt-6.1-terra": "0.159.0"},
	// code.claude.com/docs/en/model-config, checked 2026-10-28.
	EngineClaude: {
		"claude-fable-5-1":  "2.1.257",
		"claude-opus-5-5":   "2.1.280",
		"claude-sonnet-5-5": "2.1.284",
		"claude-haiku-5-5":  "2.1.293",
	},
}

// claudeCatalogModel strips Claude's case-insensitive `[1m]` context modifier;
// the window does not change which model, and so which CLI floor, applies.
func claudeCatalogModel(model string) string {
	model = strings.ToLower(strings.TrimSpace(model))
	return strings.TrimSuffix(model, "[1m]")
}

// ModelMinimum is the native CLI floor for model. A signed catalog carrying
// min_cli_versions is authoritative, including for models it omitted; older
// catalogs fall back to the frozen legacy floors. Entry floors only ever raise
// the result. No minimum is invented for other models, aliases or custom IDs.
func ModelMinimum(engine, model string, catalog *ModelCatalog) string {
	model = strings.TrimSpace(model)
	if engine == EngineClaude {
		model = claudeCatalogModel(model)
	}
	minimum := ""
	if catalog != nil && catalog.MinCLIVersions != nil {
		minimum = catalog.MinCLIVersions[model]
	} else {
		minimum = legacyModelMinimums[engine][model]
	}
	if catalog != nil {
		for _, entries := range [][]ModelCatalogEntry{catalog.Models, catalog.LiveCatalogModels} {
			for _, entry := range entries {
				if entry.Model == model && entry.MinCLIVersion != "" && (minimum == "" || !NativeVersionAtLeast(minimum, entry.MinCLIVersion)) {
					minimum = entry.MinCLIVersion
				}
			}
		}
	}
	return minimum
}

func CheckModelVersion(engine, model, observed string, catalog *ModelCatalog) error {
	minimum := ModelMinimum(engine, model, catalog)
	if minimum == "" || NativeVersionAtLeast(observed, minimum) {
		return nil
	}
	if strings.TrimSpace(observed) == "" {
		observed = "unreported"
	}
	command := map[string]string{EngineCodex: "cdx", EngineClaude: "clx", EngineGrok: "cgx"}[engine]
	return fmt.Errorf("%s requires %s CLI %s or newer; observed %s. Run %s update (or cron run to report an installed version), then retry", model, engine, minimum, observed, command)
}

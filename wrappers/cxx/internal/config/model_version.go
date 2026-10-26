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

// ModelMinimum preserves the known Terra floor even with an older signed JSON
// catalog. No minimum is invented for other models or custom provider IDs.
func ModelMinimum(engine, model string, catalog *ModelCatalog) string {
	minimum := ""
	if engine == EngineCodex && strings.TrimSpace(model) == "gpt-6.1-terra" {
		minimum = "0.159.0"
	}
	if catalog != nil {
		for _, entry := range catalog.Models {
			if entry.Model == model && entry.MinCLIVersion != "" && (minimum == "" || !NativeVersionAtLeast(minimum, entry.MinCLIVersion)) {
				minimum = entry.MinCLIVersion
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

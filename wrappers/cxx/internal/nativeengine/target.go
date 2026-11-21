package nativeengine

import (
	"errors"
	"fmt"
	"strings"

	"golang.org/x/mod/semver"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// MaintenanceTarget returns the native version to retain or install. An empty
// result skips installation, including same-version platform reconciliation.
func MaintenanceTarget(check *orchestrator.CronCheckResponse, observed string, applyMinimum func(string) string) (string, error) {
	if check.Action == "disable" {
		return "", nil
	}
	observed = strings.TrimPrefix(observed, "v")
	if observed != "" && !validMaintenanceVersion(observed) {
		return "", fmt.Errorf("invalid installed native version %q", observed)
	}
	switch check.Action {
	case "no_update":
		// The server usually omits target_version when the client is current.
		// Only a missing or unsupported executable needs the engine's floor.
		return applyMinimum(observed), nil
	case "update":
		target := strings.TrimPrefix(check.TargetVersion, "v")
		if target == "" {
			return "", errors.New("native update requested without target version")
		}
		if !validMaintenanceVersion(target) {
			return "", fmt.Errorf("invalid native update target %q", target)
		}
		target = applyMinimum(target)
		if !check.EnforceExact && observed != "" && semver.Compare("v"+target, "v"+observed) < 0 {
			return observed, nil
		}
		return target, nil
	default:
		return "", fmt.Errorf("unknown native update action %q", check.Action)
	}
}

// Native installers require all three components; semver.IsValid also accepts
// abbreviated tags such as v2.7.
func validMaintenanceVersion(version string) bool {
	return semver.IsValid("v"+version) && VersionPattern.FindString(version) == version
}

package nativeargs

import (
	"errors"
	"strings"
)

// The port has no kernel sandbox. Only an explicit grant in this host's
// signed config admits native execution. Never add a flag that skips approvals.
func CheckFreeBSDCodexLaunch(fullAccess bool, args []string) error {
	if !fullAccess {
		return errors.New("pfSense Codex requires a signed host profile permitting danger-full-access; the FreeBSD port cannot enforce a filesystem sandbox")
	}
	for i := 0; i < len(args) && args[i] != "--"; i++ {
		name, value, end := Option("codex", args, i)
		if name == "--sandbox" && value != "danger-full-access" || name == "--permission-profile" || name == "--sandbox-state-json" {
			return errors.New("the pfSense Codex port cannot enforce the requested sandbox")
		}
		if name == "--config" {
			key, setting, _ := strings.Cut(value, "=")
			key = strings.Trim(strings.TrimSpace(key), "\"'")
			if (key == "sandbox_mode" && strings.Trim(strings.TrimSpace(setting), "\"'") != "danger-full-access") || key == "default_permissions" {
				return errors.New("the pfSense Codex port cannot enforce the requested sandbox configuration")
			}
		}
		i = end
	}
	return nil
}

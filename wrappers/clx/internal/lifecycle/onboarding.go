// onboarding.go seeds Claude Code's onboarding flag into ~/.claude.json.
//
// Claude Code runs its full first-start wizard (theme picker + login method
// selection) whenever `hasCompletedOnboarding` is absent from ~/.claude.json —
// even when a perfectly valid ~/.claude/.credentials.json is on disk. On a
// freshly provisioned host the wrapper mints credentials from the orchestrator
// but Claude would still demand an interactive login, defeating the fleet auth
// sync. Seeding the flag (only when usable credentials exist) lets Claude pick
// up the minted credentials directly.
//
// Same discipline as userconfig_merge.go: never touch an unparseable file,
// only add the one key, preserve the existing file mode, write atomically.
package lifecycle

import (
	"encoding/json"
	"log/slog"
	"os"
	"strings"
)

func ensureOnboardingState(logger *slog.Logger) {
	path := userConfigPath()
	raw, _ := os.ReadFile(path)
	root := map[string]any{}
	if strings.TrimSpace(string(raw)) != "" {
		if err := json.Unmarshal(raw, &root); err != nil {
			logger.Warn("skipping onboarding seed; user .claude.json unparseable", "path", path, "err", err)
			return
		}
	}
	if v, ok := root["hasCompletedOnboarding"].(bool); ok && v {
		return
	}
	root["hasCompletedOnboarding"] = true
	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return
	}
	out = append(out, '\n')
	mode := os.FileMode(0o600)
	if fi, serr := os.Stat(path); serr == nil {
		mode = fi.Mode().Perm()
	}
	if werr := atomicWrite(path, out, mode); werr != nil {
		logger.Debug("onboarding seed write failed", "err", werr)
		return
	}
	logger.Debug("seeded hasCompletedOnboarding in ~/.claude.json")
}

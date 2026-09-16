package remote

import (
	"os"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

// policyEngines is the order in which installed signed configs are consulted.
// The switch is a fleet setting mirrored into both engines' configs, so the
// first one that exists answers for the host.
var policyEngines = []string{config.EngineCodex, config.EngineClaude}

// loadSignedConfig is a seam so the gate can be tested without a signing key.
var loadSignedConfig = loadSignedConfigForEngine

func loadSignedConfigForEngine(engine string) (*config.Config, error) {
	path, err := config.DefaultPathForEngine(engine)
	if err != nil {
		return nil, err
	}
	pubkey, err := signing.PublicKey()
	if err != nil {
		return nil, err
	}
	return config.LoadForEngine(path, pubkey, false, engine)
}

// requireEnabled refuses every target-facing verb unless signed host policy
// turns the family on.
//
// The check is per invocation and re-reads the file, not a value cached at
// startup: an operator revoking `remote` should take effect on the next command
// an agent runs, not whenever some long-lived thing happens to restart. There
// is nothing long-lived here to restart anyway, which is precisely why this is
// cheap enough to do every time.
//
// This is a fleet control, not a security boundary. The caller already has
// ssh(1) and the user's keys; switching `remote` off removes the structured
// path, not the reach. It is worth having for exactly what it is: one place to
// say a fleet does not work this way, and one place to see that it does.
func requireEnabled() error {
	var lastErr error
	for _, engine := range policyEngines {
		cfg, err := loadSignedConfig(engine)
		if err != nil {
			lastErr = err
			continue
		}
		if cfg.Remote.Enabled {
			return nil
		}
		return failf(CodeDenied, "cxx remote is disabled by signed host policy")
	}
	if lastErr != nil {
		return failf(CodeDenied, "cxx remote needs a signed host configuration and none could be read: %v", lastErr)
	}
	return failf(CodeDenied, "cxx remote is disabled by signed host policy")
}

// runsOnTarget reports whether this process is the remote half.
//
// The target VM is not a fleet host: it has no signed configuration, no API
// key, and no engine. Applying the gate there would make the feature refuse
// itself on arrival. The gate belongs where the decision is made — the machine
// that holds the ssh keys and the policy — and the verbs below are the ones
// this binary only ever invokes on itself across a connection it already
// authorized.
func runsOnTarget(verb string) bool {
	switch verb {
	case "agent-info", "job", "fs", "supervise":
		return true
	default:
		return false
	}
}

// policyOverride lets the target half of a connection state plainly that it is
// the target, for the case where the remote user happens to also be a fleet
// host with its own policy. Set by this binary when it invokes itself; never
// something an operator configures.
const targetEnv = "CXX_REMOTE_TARGET"

func onTargetByEnv() bool {
	return strings.TrimSpace(os.Getenv(targetEnv)) == "1"
}

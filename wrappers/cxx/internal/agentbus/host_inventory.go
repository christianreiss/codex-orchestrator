package agentbus

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// hostInventoryHint names the read-only operator path wherever a command
// refuses to run outside a managed lifecycle.
const hostInventoryHint = "for a read-only list of this host's registered agents from an ops shell use `cxx agent list` (host scope, signed host config)"

// hostMessagingConfig loads the host's signed fleet config for host-key reads
// (translate, host inventory). The error names every searched path because
// under sudo HOME/XDG_CONFIG_HOME decide which install is found.
func hostMessagingConfig() (*config.Config, error) {
	_, cfg, err := loadMessagingConfigs()
	if err != nil {
		return nil, err
	}
	if cfg != nil {
		return cfg, nil
	}
	searched := []string{}
	for _, engine := range []string{config.EngineCodex, config.EngineClaude, config.EngineGrok} {
		if path, pathErr := config.DefaultPathForEngine(engine); pathErr == nil {
			searched = append(searched, path)
		}
	}
	return nil, fmt.Errorf("no signed fleet configuration with agent messaging enabled (searched %s); run cdx/clx/cgx sync, or run as the user that owns the install", strings.Join(searched, ", "))
}

// listHostWithConfig is the host-authenticated inventory read. It sends only
// filters; the server pins the listing to the host the key belongs to.
func listHostWithConfig(ctx context.Context, cfg *config.Config, engine string, includeOffline bool) (map[string]any, error) {
	client, err := newRelayClient(cfg)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"include_offline": includeOffline}
	if engine != "" {
		body["engine"] = engine
	}
	var out map[string]any
	err = doJSON(ctx, client.http, client.baseURL, http.MethodPost, "/host/agent-messaging/list",
		body, map[string]string{"X-API-Key": client.apiKey}, &out)
	return out, err
}

// insideManagedLifecycle reports whether the session broker is inherited.
func insideManagedLifecycle() bool {
	return strings.TrimSpace(os.Getenv(envSocket)) != "" && strings.TrimSpace(os.Getenv(envSessionID)) != ""
}

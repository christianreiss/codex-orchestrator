package agentbus

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// Host-authenticated lookup is read-only and does not register a launch/relay.
func translateFromHost(ctx context.Context, value string) (map[string]any, error) {
	_, cfg, err := loadMessagingConfigs()
	if err != nil {
		return nil, err
	}
	if cfg == nil {
		return nil, errors.New("no enabled signed fleet configuration; run cdx/clx/cgx sync")
	}
	return translateWithConfig(ctx, cfg, value)
}

func translateWithConfig(ctx context.Context, cfg *config.Config, value string) (map[string]any, error) {
	client, err := newRelayClient(cfg)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	err = doJSON(ctx, client.http, client.baseURL, http.MethodPost, "/host/agent-messaging/translate",
		map[string]any{"value": value}, map[string]string{"X-API-Key": client.apiKey}, &out)
	return out, err
}

func runTranslate(args []string, stdout, stderr io.Writer) error {
	// Accept --json before or after the value for convenient shell use.
	jsonOutput := false
	values := []string{}
	for _, arg := range args {
		if arg == "--json" {
			jsonOutput = true
		} else {
			values = append(values, arg)
		}
	}
	if len(values) != 1 || strings.TrimSpace(values[0]) == "" {
		return errorsUsage("cxx agent translate", "<name|uuid> [--json] is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var out map[string]any
	var err error
	if strings.TrimSpace(os.Getenv(envSocket)) != "" {
		client, clientErr := sessionClientFromEnv(30 * time.Second)
		if clientErr != nil {
			return clientErr
		}
		err = client.post(ctx, "translate", map[string]any{"value": values[0]}, &out)
	} else {
		out, err = translateFromHost(ctx, values[0])
	}
	if err != nil {
		return err
	}
	return writeTranslation(stdout, out, jsonOutput)
}

func writeTranslation(stdout io.Writer, out map[string]any, jsonOutput bool) error {
	if jsonOutput {
		return writeJSON(stdout, out)
	}
	key := "uuid"
	if out["direction"] == "uuid_to_name" {
		key = "name"
	}
	value, ok := out[key].(string)
	if !ok || value == "" {
		return fmt.Errorf("translation response omitted %s", key)
	}
	_, err := fmt.Fprintln(stdout, value)
	return err
}

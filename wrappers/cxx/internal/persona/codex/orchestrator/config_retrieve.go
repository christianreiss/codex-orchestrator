package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/user"
)

type ConfigRetrieveResponse struct {
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data,omitempty"`
}

// RetrieveConfig fetches the rendered config.toml body for this host.
//
// The POST body includes `home` and `username` hints so the server can bake
// the per-user `[projects."<home>"] trust_level=trusted` stanza (see
// fe70ac3:docs/interface-cdx.md "Config Bake Rules").
func (c *Client) RetrieveConfig(ctx context.Context, digest string) (json.RawMessage, error) {
	body := map[string]any{"engine": "codex"}
	if digest != "" {
		body["sha256"] = digest
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		body["home"] = home
	}
	if u, err := user.Current(); err == nil && u != nil && u.Username != "" {
		body["username"] = u.Username
	}
	out := &ConfigRetrieveResponse{}
	if err := c.JSON(ctx, http.MethodPost, "/config/retrieve", body, out, 1); err != nil {
		return nil, err
	}
	return resourceContent(out.Data)
}

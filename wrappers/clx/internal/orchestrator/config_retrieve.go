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

// RetrieveConfig fetches settings.json for Claude engine.
//
// home + username hints let the server bake per-user trust state into
// settings.json the same way the cdx wrapper does for config.toml.
func (c *Client) RetrieveConfig(ctx context.Context, digest string) (json.RawMessage, error) {
	body := map[string]any{"engine": "claude"}
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

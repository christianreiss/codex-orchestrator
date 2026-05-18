package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
)

type ConfigRetrieveResponse struct {
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data,omitempty"`
}

// RetrieveConfig fetches the rendered config.toml body for this host.
func (c *Client) RetrieveConfig(ctx context.Context, digest string) (json.RawMessage, error) {
	body := map[string]any{"engine": "codex"}
	if digest != "" {
		body["sha256"] = digest
	}
	out := &ConfigRetrieveResponse{}
	if err := c.JSON(ctx, http.MethodPost, "/config/retrieve", body, out, 1); err != nil {
		return nil, err
	}
	return resourceContent(out.Data)
}

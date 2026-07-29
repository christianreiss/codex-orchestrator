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
// home + username are sent for server-side logging and parity with the cdx
// wrapper's request shape. They do NOT change the Claude render: the trust
// stanza ([projects."<home>"] trust_level) is baked into config.toml for codex
// only, so settings.json is byte-identical with or without these hints.
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

package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
)

type AgentsResponse struct {
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data,omitempty"`
}

// RetrieveAgents fetches the AGENTS.md document body and metadata.
func (c *Client) RetrieveAgents(ctx context.Context, digest string) (json.RawMessage, error) {
	body := map[string]any{"engine": "codex"}
	if digest != "" {
		body["sha256"] = digest
	}
	out := &AgentsResponse{}
	if err := c.JSON(ctx, http.MethodPost, "/agents/retrieve", body, out, 1); err != nil {
		return nil, err
	}
	return resourceContent(out.Data)
}

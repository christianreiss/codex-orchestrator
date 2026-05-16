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

// RetrieveAgents fetches the CLAUDE.md document body (Claude engine).
func (c *Client) RetrieveAgents(ctx context.Context, digest string) (json.RawMessage, error) {
	body := map[string]any{"engine": "claude"}
	if digest != "" {
		body["digest"] = digest
	}
	out := &AgentsResponse{}
	if err := c.JSON(ctx, http.MethodPost, "/agents/retrieve", body, out, 1); err != nil {
		return nil, err
	}
	return out.Data, nil
}

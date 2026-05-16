package orchestrator

import (
	"context"
	"net/http"
)

type UsageRecord struct {
	Engine          string  `json:"engine"`
	Model           string  `json:"model,omitempty"`
	InputTokens     int64   `json:"input_tokens"`
	OutputTokens    int64   `json:"output_tokens"`
	CachedTokens    int64   `json:"cached_tokens"`
	SessionID       string  `json:"session_id,omitempty"`
	DurationSeconds float64 `json:"duration_seconds,omitempty"`
}

func (c *Client) PostUsage(ctx context.Context, u UsageRecord) error {
	if u.Engine == "" {
		u.Engine = "claude"
	}
	return c.JSON(ctx, http.MethodPost, "/usage", u, nil, 1)
}

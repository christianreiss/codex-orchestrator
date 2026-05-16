package orchestrator

import (
	"context"
	"net/http"
)

// UsageRecord is the per-session token-count payload posted after each Codex run.
type UsageRecord struct {
	Engine          string  `json:"engine"`
	Model           string  `json:"model,omitempty"`
	InputTokens     int64   `json:"input_tokens"`
	OutputTokens    int64   `json:"output_tokens"`
	CachedTokens    int64   `json:"cached_tokens"`
	ReasoningTokens int64   `json:"reasoning_tokens"`
	SessionID       string  `json:"session_id,omitempty"`
	DurationSeconds float64 `json:"duration_seconds,omitempty"`
}

// PostUsage reports a single session's token counts. Best-effort: failures
// don't block the foreground exec.
func (c *Client) PostUsage(ctx context.Context, u UsageRecord) error {
	if u.Engine == "" {
		u.Engine = "codex"
	}
	return c.JSON(ctx, http.MethodPost, "/usage", u, nil, 1)
}

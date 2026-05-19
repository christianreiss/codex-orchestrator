package orchestrator

import (
	"context"
	"net/http"
)

// UsageRecord is the legacy per-session payload retained for callers that
// still post a single record. New code should prefer UsagesBatch + PostUsages
// which matches the bash wrapper's `{usages:[…]}` wire shape.
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

// UsageEntry is a single row inside a UsagesBatch. Mirrors the legacy
// python `build_entry` shape in bin/cdx.d/03-sync-50-usage.sh — every field
// is omitempty because the bash wrapper omitted absent counters rather than
// sending zeros (the server's token-usage normaliser distinguishes the two).
type UsageEntry struct {
	Engine    string  `json:"engine,omitempty"`
	Model     string  `json:"model,omitempty"`
	Line      string  `json:"line,omitempty"` // raw "Token usage: …" line for the audit log
	Total     int64   `json:"total,omitempty"`
	Input     int64   `json:"input,omitempty"`
	Output    int64   `json:"output,omitempty"`
	Cached    int64   `json:"cached,omitempty"`
	Reasoning int64   `json:"reasoning,omitempty"`
	SessionID string  `json:"session_id,omitempty"`
	Duration  float64 `json:"duration_seconds,omitempty"`
}

// UsagesBatch is the legacy `{engine, fqdn, usages:[…]}` wire shape that
// api/src/services/token-usage.ts accepts at the array-shape branch.
type UsagesBatch struct {
	Engine string       `json:"engine"`
	FQDN   string       `json:"fqdn,omitempty"`
	Usages []UsageEntry `json:"usages"`
}

// PostUsage reports a single session's token counts in the legacy single-record
// shape. Kept for backwards compatibility; new code calls PostUsages.
// Best-effort: failures don't block the foreground exec.
func (c *Client) PostUsage(ctx context.Context, u UsageRecord) error {
	if u.Engine == "" {
		u.Engine = "codex"
	}
	return c.JSON(ctx, http.MethodPost, "/usage", u, nil, 1)
}

// PostUsages reports a batch of usage entries using the legacy array shape.
// The server (api/src/services/token-usage.ts:180-195) accepts both this
// shape and the single-record shape transparently.
func (c *Client) PostUsages(ctx context.Context, batch UsagesBatch) error {
	if batch.Engine == "" {
		batch.Engine = "codex"
	}
	return c.JSON(ctx, http.MethodPost, "/usage", batch, nil, 1)
}

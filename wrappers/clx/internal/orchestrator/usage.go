package orchestrator

import (
	"context"
	"net/http"
)

// UsageRecord is the legacy per-session shape kept for backwards compat.
// New code should prefer UsagesBatch + PostUsages.
type UsageRecord struct {
	Engine          string  `json:"engine"`
	Model           string  `json:"model,omitempty"`
	InputTokens     int64   `json:"input_tokens"`
	OutputTokens    int64   `json:"output_tokens"`
	CachedTokens    int64   `json:"cached_tokens"`
	SessionID       string  `json:"session_id,omitempty"`
	DurationSeconds float64 `json:"duration_seconds,omitempty"`
}

// UsageEntry is a single row inside a UsagesBatch. Mirrors the legacy
// python `build_entry` shape from bin/clx.d/03-sync-50-usage.sh — every
// field is omitempty because the bash wrapper omitted absent counters
// rather than sending zeros (the server token-usage normaliser
// distinguishes the two).
//
// Note: Claude usage has no `reasoning` field but does carry
// `cache_creation` (first-time prompt-cache write) separately from
// `cached` (cache read).
type UsageEntry struct {
	Engine        string  `json:"engine,omitempty"`
	Model         string  `json:"model,omitempty"`
	Line          string  `json:"line,omitempty"`
	Total         int64   `json:"total,omitempty"`
	Input         int64   `json:"input,omitempty"`
	Output        int64   `json:"output,omitempty"`
	Cached        int64   `json:"cached,omitempty"`
	CacheCreation int64   `json:"cache_creation,omitempty"`
	SessionID     string  `json:"session_id,omitempty"`
	Duration      float64 `json:"duration_seconds,omitempty"`
}

// UsagesBatch is the legacy `{engine, fqdn, usages:[…]}` wire shape that
// api/src/services/token-usage.ts accepts at the array-shape branch.
type UsagesBatch struct {
	Engine string       `json:"engine"`
	FQDN   string       `json:"fqdn,omitempty"`
	Usages []UsageEntry `json:"usages"`
}

func (c *Client) PostUsage(ctx context.Context, u UsageRecord) error {
	if u.Engine == "" {
		u.Engine = "claude"
	}
	return c.JSON(ctx, http.MethodPost, "/usage", u, nil, 1)
}

// PostUsages reports a batch of usage entries using the legacy array shape.
// Server already accepts both this shape and the single-record shape.
func (c *Client) PostUsages(ctx context.Context, batch UsagesBatch) error {
	if batch.Engine == "" {
		batch.Engine = "claude"
	}
	return c.JSON(ctx, http.MethodPost, "/usage", batch, nil, 1)
}

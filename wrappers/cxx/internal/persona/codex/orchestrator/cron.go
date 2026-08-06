package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"net/http"
)

// CronCheckRequest mirrors POST /cron/check body.
// Matches api/src/routes/host/index.ts:118-177.
type CronCheckRequest struct {
	Engine         string `json:"engine"`
	ClientVersion  string `json:"client_version"`
	WrapperVersion string `json:"wrapper_version"`

	// Probe marks a caller that is not the cron job — the lifecycle asks the
	// same question on its way out of an interactive session. The server skips
	// the last_cron_check stamp for it, so a dead cron still reads as dead.
	Probe bool `json:"probe,omitempty"`
}

// CronWrapperBlock is the nested wrapper-action sub-object returned by /cron/check.
type CronWrapperBlock struct {
	Action        string `json:"action"`
	TargetVersion string `json:"target_version"`
	SHA256        string `json:"sha256"`
	URL           string `json:"url"`
}

// CronCheckResponse mirrors POST /cron/check response.
type CronCheckResponse struct {
	Action        string            `json:"action"`
	Wrapper       *CronWrapperBlock `json:"wrapper,omitempty"`
	ClientVersion string            `json:"client_version,omitempty"`

	// Optional fields returned when action == "update".
	TargetVersion string `json:"target_version,omitempty"`
	Tag           string `json:"tag,omitempty"`
	EnforceExact  bool   `json:"enforce_exact,omitempty"`
}

// CronReportRequest mirrors POST /cron/report body.
type CronReportRequest struct {
	Engine         string `json:"engine"`
	ClientVersion  string `json:"client_version"`
	WrapperVersion string `json:"wrapper_version"`
}

// CronCheck posts the host's current versions and returns the server's
// recommended action (no_update / update) plus the wrapper sub-action.
func (c *Client) CronCheck(ctx context.Context, r CronCheckRequest) (*CronCheckResponse, error) {
	if r.Engine == "" {
		r.Engine = "codex"
	}
	out := &CronCheckResponse{}
	if err := c.JSON(ctx, http.MethodPost, "/cron/check", r, out, 1); err != nil {
		return nil, fmt.Errorf("cron check: %w", err)
	}
	return out, nil
}

// CronReport posts the host's current versions after an update.
func (c *Client) CronReport(ctx context.Context, r CronReportRequest) error {
	if r.Engine == "" {
		r.Engine = "codex"
	}
	if r.ClientVersion == "" && r.WrapperVersion == "" {
		return errors.New("cron report: client_version or wrapper_version is required")
	}
	out := map[string]any{}
	if err := c.JSON(ctx, http.MethodPost, "/cron/report", r, &out, 1); err != nil {
		return fmt.Errorf("cron report: %w", err)
	}
	return nil
}

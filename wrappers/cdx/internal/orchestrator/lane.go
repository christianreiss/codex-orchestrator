package orchestrator

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// LaneInfo describes a host's quota lane (normal vs spark).
type LaneInfo struct {
	Status string `json:"status"`
	Data   struct {
		Lane string `json:"lane"`
	} `json:"data"`
}

func (c *Client) GetLane(ctx context.Context) (string, error) {
	out := &LaneInfo{}
	if err := c.JSON(ctx, http.MethodGet, "/host/lane", nil, out, 1); err != nil {
		return "", err
	}
	return out.Data.Lane, nil
}

func (c *Client) SetLane(ctx context.Context, lane string) error {
	lane = strings.ToLower(strings.TrimSpace(lane))
	if lane != "normal" && lane != "spark" {
		return fmt.Errorf("invalid lane %q (want normal|spark)", lane)
	}
	out := &LaneInfo{}
	return c.JSON(ctx, http.MethodPost, "/host/lane", map[string]string{"lane": lane}, out, 1)
}

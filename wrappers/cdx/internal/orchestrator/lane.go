package orchestrator

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// LaneInfo describes a host's quota lane (normal vs spark). The orchestrator's
// GET/POST /host/lane handlers return {lane_preference, effective_lane, ...},
// and the standard envelope duplicates those fields both at the root and under
// `data`. We read both positions so the client stays correct regardless of
// which envelope shape a given server build emits.
type LaneInfo struct {
	Status         string `json:"status"`
	LanePreference string `json:"lane_preference"`
	EffectiveLane  string `json:"effective_lane"`
	Data           struct {
		LanePreference string `json:"lane_preference"`
		EffectiveLane  string `json:"effective_lane"`
	} `json:"data"`
}

// effective returns the host's effective lane, preferring the root-level field,
// falling back to the `data`-nested copy, and finally to the server's own
// default ("normal") when neither is present.
func (l *LaneInfo) effective() string {
	if l.EffectiveLane != "" {
		return l.EffectiveLane
	}
	if l.Data.EffectiveLane != "" {
		return l.Data.EffectiveLane
	}
	return "normal"
}

func (c *Client) GetLane(ctx context.Context) (string, error) {
	out := &LaneInfo{}
	if err := c.JSON(ctx, http.MethodGet, "/host/lane", nil, out, 1); err != nil {
		return "", err
	}
	return out.effective(), nil
}

func (c *Client) SetLane(ctx context.Context, lane string) error {
	lane = strings.ToLower(strings.TrimSpace(lane))
	if lane != "normal" && lane != "spark" {
		return fmt.Errorf("invalid lane %q (want normal|spark)", lane)
	}
	out := &LaneInfo{}
	return c.JSON(ctx, http.MethodPost, "/host/lane", map[string]string{"lane": lane}, out, 1)
}

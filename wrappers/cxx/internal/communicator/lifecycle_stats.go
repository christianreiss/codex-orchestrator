package communicator

import (
	"context"
	"fmt"
	"strconv"
	"time"
)

// LifecycleStats observes the existing owner only. Neither snapshot starts an
// owner, registers a client, changes its idle deadline, nor calls the server.
type LifecycleStats struct {
	base  string
	start Owner
}

func NewLifecycleStats(base string) *LifecycleStats { return &LifecycleStats{base: base} }

const lifecycleStatsBudget = 200 * time.Millisecond

func (s *LifecycleStats) snapshot() (Owner, bool) {
	// Exit must still report after the native launch context was cancelled.
	ctx, cancel := context.WithTimeout(context.Background(), lifecycleStatsBudget)
	defer cancel()
	owner, ok := ownerStatus(ctx, s.base, true)
	return owner, ok && owner.PID > 0
}

func (s *LifecycleStats) unavailable(phase string) string {
	if endpointFor(s.base) == nil {
		return phase + ": not configured"
	}
	return phase + ": unavailable | clients=unknown"
}

func (s *LifecycleStats) Start() string {
	owner, ok := s.snapshot()
	if !ok {
		return s.unavailable("start")
	}
	s.start = owner
	state := "already running"
	if ep := endpointFor(s.base); ep != nil {
		ep.mu.Lock()
		_, started := ep.startedPIDs[owner.PID]
		ep.mu.Unlock()
		if started {
			state = "started for this session"
		}
	}
	return lifecycleStatsLine("start", state, owner)
}

func (s *LifecycleStats) End() string {
	owner, ok := s.snapshot()
	if !ok {
		return s.unavailable("end")
	}
	state := "running"
	if s.start.PID > 0 && (s.start.PID != owner.PID ||
		(s.start.InstanceID != "" && owner.InstanceID != "" && s.start.InstanceID != owner.InstanceID)) {
		state = "owner changed"
	}
	return lifecycleStatsLine("end", state, owner)
}

func lifecycleStatsLine(phase, state string, owner Owner) string {
	clients := "unknown"
	if owner.Clients != nil && *owner.Clients >= 0 {
		clients = strconv.Itoa(*owner.Clients)
	}
	return fmt.Sprintf("%s: %s | pid=%d | clients=%s", phase, state, owner.PID, clients)
}

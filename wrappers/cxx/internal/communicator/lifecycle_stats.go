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
	base    string
	start   Owner
	current Owner
}

func NewLifecycleStats(base string) *LifecycleStats { return &LifecycleStats{base: base} }

const lifecycleStatsBudget = 200 * time.Millisecond

func (s *LifecycleStats) snapshot() (Owner, bool) {
	s.current = Owner{}
	// Exit must still report after the native launch context was cancelled.
	ctx, cancel := context.WithTimeout(context.Background(), lifecycleStatsBudget)
	defer cancel()
	owner, ok := ownerStatus(ctx, s.base, true)
	if ok {
		s.current = owner
	}
	return owner, ok && owner.PID > 0
}

func (s *LifecycleStats) unavailable(phase string) string {
	if endpointFor(s.base) == nil {
		return phase + ": not configured"
	}
	return phase + ": unavailable | sessions=unknown | leases=unknown"
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
	sessions := "unknown"
	if owner.ManagedSessions != nil && *owner.ManagedSessions >= 0 {
		sessions = strconv.Itoa(*owner.ManagedSessions)
	}
	return fmt.Sprintf("%s: %s | pid=%d | sessions=%s | leases=%s", phase, state, owner.PID, sessions, clients)
}

// Table uses the same bounded snapshot as Start/End; rendering does no I/O.
func (s *LifecycleStats) Table() [][]string {
	m := s.current.Matrix
	if m == nil {
		return nil
	}
	rows := [][]string{{"ENGINE", "LEASE", "AUTH", "PROVIDER", "SESSION", "RECEIVER", "OTHER"}}
	for _, row := range m.Rows {
		if (row.Engine == "shared" || row.Engine == "unknown") && row.Lease+row.Auth+row.Provider+row.Session+row.Receiver+row.Other == 0 {
			continue
		}
		state := []string{"?", "?", "?", "?"}
		if m.StateAvailable {
			state = []string{strconv.Itoa(row.Provider), strconv.Itoa(row.Session), strconv.Itoa(row.Receiver), strconv.Itoa(row.Other)}
		}
		rows = append(rows, []string{row.Engine, strconv.Itoa(row.Lease), strconv.Itoa(row.Auth), state[0], state[1], state[2], state[3]})
	}
	return rows
}
func (s *LifecycleStats) Details() []string {
	if s.current.Matrix == nil {
		return nil
	}
	return []string{"Attachments by type; columns overlap per launch. ? = unavailable."}
}

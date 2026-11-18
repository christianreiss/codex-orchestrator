package communicator

import (
	"context"
	"fmt"
	"strconv"
	"strings"
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
		// An engine row with nothing attached (including shared/unknown) is noise.
		if row.Lease+row.Auth+row.Provider+row.Session+row.Receiver+row.Other == 0 {
			continue
		}
		state := []string{"?", "?", "?", "?"}
		if m.StateAvailable {
			state = []string{strconv.Itoa(row.Provider), strconv.Itoa(row.Session), strconv.Itoa(row.Receiver), strconv.Itoa(row.Other)}
		}
		rows = append(rows, []string{row.Engine, strconv.Itoa(row.Lease), strconv.Itoa(row.Auth), state[0], state[1], state[2], state[3]})
	}
	if len(rows) == 1 {
		return nil
	}
	return rows
}
func (s *LifecycleStats) Details() []string {
	if s.current.Matrix == nil {
		return nil
	}
	return []string{"Attachments by type; columns overlap per launch. ? = unavailable."}
}

// StartSummary snapshots the owner like Start and returns one compact line for
// the launch card, e.g. "running · pid 1436 · 0 sessions · 5 leases (codex 2)".
// configured is false when this launch has no communicator endpoint at all;
// ok is false when the owner could not be observed.
func (s *LifecycleStats) StartSummary() (line string, configured, ok bool) {
	if endpointFor(s.base) == nil {
		return "", false, true
	}
	owner, alive := s.snapshot()
	if !alive {
		return "unavailable", true, false
	}
	s.start = owner
	state := "running"
	if ep := endpointFor(s.base); ep != nil {
		ep.mu.Lock()
		_, started := ep.startedPIDs[owner.PID]
		ep.mu.Unlock()
		if started {
			state = "started"
		}
	}
	return compactLine(state, owner, s.leasesByEngine()), true, true
}

// EndSummary is the compact exit counterpart of End.
func (s *LifecycleStats) EndSummary() string {
	if endpointFor(s.base) == nil {
		return ""
	}
	owner, alive := s.snapshot()
	if !alive {
		return "unavailable"
	}
	state := "running"
	if s.start.PID > 0 && (s.start.PID != owner.PID ||
		(s.start.InstanceID != "" && owner.InstanceID != "" && s.start.InstanceID != owner.InstanceID)) {
		state = "owner changed"
	}
	return compactLine(state, owner, s.leasesByEngine())
}

func compactLine(state string, owner Owner, byEngine string) string {
	sessions := "? sessions"
	if owner.ManagedSessions != nil && *owner.ManagedSessions >= 0 {
		sessions = plural(*owner.ManagedSessions, "session")
	}
	leases := "? leases"
	if owner.Clients != nil && *owner.Clients >= 0 {
		leases = plural(*owner.Clients, "lease")
	}
	if byEngine != "" {
		leases += " (" + byEngine + ")"
	}
	return fmt.Sprintf("%s · pid %d · %s · %s", state, owner.PID, sessions, leases)
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return strconv.Itoa(n) + " " + word + "s"
}

// leasesByEngine names the engines holding leases, e.g. "codex 2, unknown 3".
func (s *LifecycleStats) leasesByEngine() string {
	m := s.current.Matrix
	if m == nil {
		return ""
	}
	parts := []string{}
	for _, row := range m.Rows {
		if row.Lease > 0 {
			parts = append(parts, row.Engine+" "+strconv.Itoa(row.Lease))
		}
	}
	return strings.Join(parts, ", ")
}

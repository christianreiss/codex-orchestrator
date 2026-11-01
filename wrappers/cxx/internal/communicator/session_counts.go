package communicator

// Counts describe different evidence. A local lease is an anonymous transport,
// not a native session. Native identity comes only from authenticated state streams.
// Caller holds server.mu; the connection mutex protects stream lifecycle.
type sessionCounts struct {
	TransportLeases          int
	ManagedSessions          *int
	AnonymousTransportLeases int
}

func (s *server) sessionCountsLocked() sessionCounts {
	out := sessionCounts{TransportLeases: s.leases, AnonymousTransportLeases: s.leases}
	if s.conn == nil {
		return out
	}
	s.conn.mu.Lock()
	defer s.conn.mu.Unlock()
	if !s.conn.stateEnabled {
		return out
	}
	ids := map[string]bool{}
	for _, stream := range s.conn.states {
		if stream.epoch != "" && !stream.stopping && stream.sessionID != "" {
			ids[stream.sessionID] = true
		}
	}
	n := len(ids)
	out.ManagedSessions = &n
	return out
}

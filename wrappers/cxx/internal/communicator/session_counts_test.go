package communicator

import "testing"

func TestSessionCountsDeduplicateAuthenticatedNativeStreams(t *testing.T) {
	s := &server{leases: 10, conn: &connection{stateEnabled: true, states: map[string]*stateRelay{
		"session": {sessionID: "one", epoch: "epoch"}, "receiver": {sessionID: "one", epoch: "epoch"},
		"other-engine": {sessionID: "two", epoch: "epoch"}, "unverified": {sessionID: "three"},
		"relay": {epoch: "epoch"}, "closing": {sessionID: "four", epoch: "epoch", stopping: true},
	}}}
	got := s.sessionCountsLocked()
	if got.ManagedSessions == nil || *got.ManagedSessions != 2 || got.TransportLeases != 10 || got.AnonymousTransportLeases != 10 {
		t.Fatalf("counts=%+v", got)
	}
	s.conn = nil
	if s.sessionCountsLocked().ManagedSessions != nil {
		t.Fatal("disconnected native session count must remain unknown")
	}
}

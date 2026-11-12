package communicator

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConnectionMatrixSeparatesTransportAndAuthenticatedStreams(t *testing.T) {
	s := &server{leases: 5, leaseClasses: map[leaseClass]int{{engine: "codex"}: 2, {engine: "grok", auth: true}: 1, {engine: "shared"}: 1}, conn: &connection{stateEnabled: true, states: map[string]*stateRelay{
		"provider": {engine: "codex", topic: "provider", epoch: "one"},
		"session":  {engine: "codex", topic: "session", sessionID: "native", epoch: "one"},
		"receiver": {engine: "codex", topic: "receiver", sessionID: "native", epoch: "one"},
		"unknown":  {topic: "session", sessionID: "legacy", epoch: "one"},
		"daemon":   {topic: "daemon", epoch: "one"},
		"pending":  {engine: "claude", topic: "session"},
		"closing":  {engine: "grok", topic: "session", epoch: "one", stopping: true},
	}}}
	m := s.connectionMatrixLocked()
	if !m.StateAvailable || len(m.Rows) != 6 {
		t.Fatalf("matrix=%+v", m)
	}
	if got := m.Rows[0]; got.Lease != 2 || got.Provider != 1 || got.Session != 1 || got.Receiver != 1 {
		t.Fatalf("codex=%+v", got)
	}
	if m.Rows[2].Auth != 1 || m.Rows[4].Lease != 1 || m.Rows[5].Lease != 1 || m.Rows[5].Session != 1 || m.Rows[5].Other != 1 {
		t.Fatalf("matrix=%+v", m)
	}
	if got := s.sessionCountsLocked(); got.ManagedSessions == nil || *got.ManagedSessions != 2 {
		t.Fatalf("unique sessions=%+v", got)
	}
	s.conn = nil
	m = s.connectionMatrixLocked()
	if m.StateAvailable || m.Rows[0].Provider != 0 || m.Rows[0].Lease != 2 {
		t.Fatalf("disconnected=%+v", m)
	}
}

func TestLeaseClassificationCountsMultiScopeAttachmentOnce(t *testing.T) {
	s := &server{jobs: map[string]syncJob{}, jobRefs: map[string]int{}}
	ids, _, err := s.registerJobs(httptest.NewRequest("POST", "/_comm/lease", strings.NewReader(`[{"engine":"codex","config":"/signed","env":{"HOME":"/one"}},{"engine":"claude","config":"/signed","env":{"HOME":"/one"}}]`)))
	if err != nil {
		t.Fatal(err)
	}
	if got := s.classifyLeaseLocked(ids); got.engine != "shared" || got.auth {
		t.Fatalf("class=%+v", got)
	}
	if got := s.classifyLeaseLocked(nil); got.engine != "unknown" {
		t.Fatalf("anonymous=%+v", got)
	}
}

func TestLifecycleMatrixKeepsUnknownAuthorityAndOldOwnersHonest(t *testing.T) {
	s := &LifecycleStats{current: Owner{Matrix: &ConnectionMatrix{Rows: []ConnectionRow{{Engine: "codex", Lease: 3}}}}}
	rows := s.Table()
	if len(rows) != 2 || rows[1][1] != "3" || rows[1][3] != "?" {
		t.Fatalf("rows=%v", rows)
	}
	s.current.Matrix.StateAvailable = true
	if s.Table()[1][3] != "0" {
		t.Fatal("confirmed zero missing")
	}
	s.current = Owner{}
	if s.Table() != nil || s.Details() != nil {
		t.Fatal("old owner fabricated matrix")
	}
}

func TestMatrixNeverCountsARejectedOrClosedStateAttachment(t *testing.T) {
	c := &connection{stateEnabled: true, states: map[string]*stateRelay{"pending": {engine: "codex", topic: "session", events: make(chan StateFrame, 2)}}}
	c.receiveState(StateFrame{Type: "state_close", StreamID: "pending", OwnerEpoch: "owner"})
	s := &server{conn: c}
	if got := s.connectionMatrixLocked().Rows[0].Session; got != 0 {
		t.Fatalf("rejected attachment counted: %d", got)
	}
	c.states["live"] = &stateRelay{engine: "codex", topic: "session", events: make(chan StateFrame, 2)}
	c.receiveState(StateFrame{Type: "state_snapshot", StreamID: "live", OwnerEpoch: "owner"})
	if got := s.connectionMatrixLocked().Rows[0].Session; got != 1 {
		t.Fatalf("snapshot missing: %d", got)
	}
	c.receiveState(StateFrame{Type: "state_close", StreamID: "live", OwnerEpoch: "owner"})
	if got := s.connectionMatrixLocked().Rows[0].Session; got != 0 {
		t.Fatalf("closed attachment counted: %d", got)
	}
}

func TestLifecycleTableOmitsEmptyRows(t *testing.T) {
	s := &LifecycleStats{current: Owner{Matrix: &ConnectionMatrix{StateAvailable: true, Rows: []ConnectionRow{{Engine: "codex", Lease: 1}, {Engine: "grok"}, {Engine: "unknown"}}}}}
	rows := s.Table()
	if len(rows) != 2 || rows[1][0] != "codex" {
		t.Fatalf("rows=%v", rows)
	}
	s.current.Matrix.Rows = []ConnectionRow{{Engine: "unknown"}}
	if s.Table() != nil {
		t.Fatal("empty matrix rendered a header-only table")
	}
	s.current.Matrix.Rows = []ConnectionRow{{Engine: "unknown", Session: 9}}
	if got := s.Table(); len(got) != 2 || got[1][0] != "unknown" {
		t.Fatalf("non-zero unknown row hidden: %v", got)
	}
}

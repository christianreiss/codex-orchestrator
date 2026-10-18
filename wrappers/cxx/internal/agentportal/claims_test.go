package agentportal

import (
	"encoding/json"
	"testing"
)

func TestClaimsTrackOnlyExplicitOperations(t *testing.T) {
	s := &Session{}
	s.observeClaim("/heartbeat", json.RawMessage(`{"id":"unrelated","state":"active"}`))
	if len(s.activeClaims) != 0 {
		t.Fatal("heartbeat invented an operation")
	}
	s.observeClaim("/agent-messaging/claims/acquire", json.RawMessage(`{"id":"one","state":"waiting"}`))
	if len(s.activeClaims) != 0 {
		t.Fatal("waiting claim was renewed")
	}
	s.observeClaim("/agent-messaging/claims/status", json.RawMessage(`{"id":"one","state":"active"}`))
	if !s.activeClaims["one"] {
		t.Fatal("granted operation missing")
	}
	s.observeClaim("/agent-messaging/claims/release", json.RawMessage(`{"id":"one","state":"uncertain"}`))
	if len(s.activeClaims) != 0 {
		t.Fatal("uncertain operation was renewed")
	}
}

func TestScopeBrokerRoutesStaySessionBound(t *testing.T) {
	b := &Broker{session: &Session{ID: "ours"}}
	for _, operation := range []string{"context/get", "context/update", "rooms/list", "rooms/read", "rooms/send", "claims/acquire", "claims/status", "claims/release"} {
		if !b.allowedPath("/host/agent-sessions/ours/agent-messaging/" + operation) {
			t.Fatal(operation)
		}
		if b.allowedPath("/host/agent-sessions/theirs/agent-messaging/" + operation) {
			t.Fatal("cross-session route allowed")
		}
	}
	if !b.requiresReceivePlanePolicy("/host/agent-sessions/ours/agent-messaging/rooms/read", nil) {
		t.Fatal("history bypasses receive policy")
	}
}

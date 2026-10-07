package agentportal

import "testing"

func TestPublicationBrokerRoutesRemainBoundToSession(t *testing.T) {
	b := &Broker{session: &Session{ID: "session-one"}}
	for _, operation := range []string{"groups/list", "groups/create", "groups/detail", "subscribe", "unsubscribe", "subscriptions", "publish"} {
		if !b.allowedPath("/host/agent-sessions/session-one/agent-messaging/" + operation) {
			t.Fatalf("publication operation blocked: %s", operation)
		}
		if b.allowedPath("/host/agent-sessions/session-two/agent-messaging/" + operation) {
			t.Fatalf("publication operation escaped session: %s", operation)
		}
	}
	for _, path := range []string{"/admin/agent-messaging/publish", "/host/agent-sessions/session-one/agent-messaging/publish/all", "/host/agent-sessions/session-one/agent-messaging/groups/delete"} {
		if b.allowedPath(path) {
			t.Fatalf("unexpected publication route exposed: %s", path)
		}
	}
}

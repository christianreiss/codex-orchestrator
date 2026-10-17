package agentportal

import "testing"

// The cxx-agent MCP tools host_insecure_enable, agent_spawn,
// agent_spawn_status, agent_stop and advisor_* post these suffixes through the broker
// (agentbus/mcp.go). A suffix missing here makes an advertised tool fail with
// broker_operation_forbidden before the API, which owns the authorization,
// ever sees the request.
func TestDaemonBrokerRoutesRemainBoundToSession(t *testing.T) {
	b := &Broker{session: &Session{ID: "session-one"}}
	for _, operation := range []string{"insecure-enable", "spawn", "spawn-status", "stop", "advisor/ask", "advisor/close", "advisor/status"} {
		if !b.allowedPath("/host/agent-sessions/session-one/agent-messaging/" + operation) {
			t.Fatalf("daemon operation blocked: %s", operation)
		}
		if b.allowedPath("/host/agent-sessions/session-two/agent-messaging/" + operation) {
			t.Fatalf("daemon operation escaped session: %s", operation)
		}
	}
	for _, path := range []string{
		"/admin/hosts/59/insecure/enable",
		"/host/agent-sessions/session-one/agent-messaging/insecure-enable/all",
		"/host/agent-sessions/session-one/agent-messaging/insecure-disable",
	} {
		if b.allowedPath(path) {
			t.Fatalf("unexpected insecure-window route exposed: %s", path)
		}
	}
}

package agentportal

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Every agent_* MCP tool posts an agent-messaging suffix through this broker
// (agentbus). agent_conf_list and agent_digest_get shipped with their API
// routes but without a broker entry, so the advertised tools failed with
// broker_operation_forbidden before the API, which owns the authorization,
// ever saw the request. Scan the literal suffixes so the next new tool cannot
// drift the same way; suffixes built at runtime are listed explicitly.
func TestBrokerAllowsEveryAgentbusMessagingOperation(t *testing.T) {
	files, err := filepath.Glob("../agentbus/*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("agentbus sources not found: %v", err)
	}
	literal := regexp.MustCompile(`\.post\(ctx, "([^"]+)"`)
	operations := map[string]bool{}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range literal.FindAllStringSubmatch(string(source), -1) {
			// A trailing slash is a prefix completed at runtime
			// ("watchdog/", "advisor/", "deliveries/"), covered below.
			if !strings.HasSuffix(match[1], "/") {
				operations[match[1]] = true
			}
		}
	}
	for _, required := range []string{"conf/list", "digest", "message", "conf/join"} {
		if !operations[required] {
			t.Fatalf("source scan no longer finds %q; update the pattern", required)
		}
	}
	for _, runtime := range []string{
		"chats/list", "chats/read", "chats/send",
		"chats/room-one/attachments", "chats/room-one/attachments/get", "chats/room-one/attachments/file-one/chunks", "chats/room-one/attachments/file-one/seal",
		"watchdog/get", "watchdog/enable", "watchdog/disable", "watchdog/finish",
		"advisor/ask", "advisor/close", "advisor/status",
		"insecure-enable", "spawn", "spawn-status", "stop",
		"groups/list", "groups/create", "groups/detail", "groups/delete",
		"subscribe", "unsubscribe", "subscriptions", "publish",
		"deliveries/claim",
		"deliveries/0b5c6a3e-8f1d-4c2a-9e7b-3d4f5a6b7c8d/renew",
		"deliveries/0b5c6a3e-8f1d-4c2a-9e7b-3d4f5a6b7c8d/ack",
	} {
		operations[runtime] = true
	}
	b := &Broker{session: &Session{ID: "session-one"}}
	for operation := range operations {
		if !b.allowedPath("/host/agent-sessions/session-one/agent-messaging/" + operation) {
			t.Errorf("advertised operation blocked by broker: %s", operation)
		}
		if b.allowedPath("/host/agent-sessions/session-two/agent-messaging/" + operation) {
			t.Errorf("operation escaped session: %s", operation)
		}
	}
}

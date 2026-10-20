package agentportal

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Workflow tools use a shared dispatch map, so scanning literal client.post calls misses them.
func TestBrokerAllowsEveryWorkflowToolAndFencesSessionAndUnknownOperations(t *testing.T) {
	source, err := os.ReadFile("../agentbus/workflows.go")
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)var workflowPaths = map\[string\]string\{(.*?)\n\}`).FindSubmatch(source)
	if len(block) != 2 {
		t.Fatal("workflow dispatch map not found")
	}
	paths := regexp.MustCompile(`:\s*"(workflows/[^"]+)"`).FindAllSubmatch(block[1], -1)
	if len(paths) != 13 {
		t.Fatalf("expected thirteen workflow operations, found %d", len(paths))
	}
	broker := &Broker{session: &Session{ID: "workflow-session"}}
	for _, match := range paths {
		operation := string(match[1])
		if !broker.allowedPath("/host/agent-sessions/workflow-session/agent-messaging/" + operation) {
			t.Errorf("workflow tool blocked before API: %s", operation)
		}
		if broker.allowedPath("/host/agent-sessions/other-session/agent-messaging/" + operation) {
			t.Errorf("workflow tool escaped session: %s", operation)
		}
		if broker.allowedPath("/host/agent-sessions/workflow-session/agent-messaging/" + operation + "/extra") {
			t.Errorf("workflow route accepted a suffix: %s", operation)
		}
	}
	for _, operation := range []string{"state", "prepare-cancel", "revert", "admin", "../../admin/workflow-definitions"} {
		if broker.allowedPath("/host/agent-sessions/workflow-session/agent-messaging/workflows/" + strings.TrimSpace(operation)) {
			t.Errorf("unadvertised workflow operation allowed: %s", operation)
		}
	}
}

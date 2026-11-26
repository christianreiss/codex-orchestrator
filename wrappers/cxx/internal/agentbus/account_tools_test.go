package agentbus

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func listedToolNames(t *testing.T) map[string]bool {
	t.Helper()
	res := handleMCPRequest(context.Background(), nil, mcpRequest{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "tools/list"}, false, nil)
	result, _ := res["result"].(map[string]any)
	tools, _ := result["tools"].([]map[string]any)
	names := map[string]bool{}
	for _, tool := range tools {
		name, _ := tool["name"].(string)
		names[name] = true
	}
	return names
}

func TestAccountToolsListedForClaudeOnly(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	if names := listedToolNames(t); !names["account_status"] || !names["account_switch"] || !names["quota_get"] {
		t.Fatal("account tools missing for Claude")
	}
	for _, engine := range []string{"codex", "grok", "kimi"} {
		t.Setenv("CXX_AGENT_PORTAL_ENGINE", engine)
		names := listedToolNames(t)
		if names["account_status"] || names["account_switch"] || !names["quota_get"] {
			t.Fatalf("%s: account tools listed or catalog damaged", engine)
		}
		_, err := callMCPTool(context.Background(), nil, nil, "account_switch", map[string]any{"target": "auto"})
		if err == nil || !strings.Contains(err.Error(), "Claude sessions only") {
			t.Fatalf("%s: unsupported engine error: %v", engine, err)
		}
	}
}

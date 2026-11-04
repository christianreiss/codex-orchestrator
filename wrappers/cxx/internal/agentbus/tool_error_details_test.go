package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A claim refused for missing connection proof must reach the model with its
// structured diagnosis: proof_state tells "client too old" from "reconnect".
// A plain error keeps its single text item.
func TestToolErrorsCarryServerErrorDetails(t *testing.T) {
	body := `{"status":"error","code":"claim_connection_required","message":"A proven native connection is required","claim_connection":{"proof_state":"client_too_old","communicator_version":"0.9.123","minimum_version":"0.9.125"}}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/claims/acquire") {
			w.WriteHeader(http.StatusConflict)
			io.WriteString(w, body)
			return
		}
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `{"status":"error","code":"forbidden","message":"Forbidden"}`)
	}))
	defer server.Close()
	client := &sessionClient{id: "launch", http: &http.Client{Transport: rewriteTransport{server}}}
	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		params, _ := json.Marshal(map[string]any{"name": name, "arguments": args})
		response := handleMCPRequest(context.Background(), client, mcpRequest{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "tools/call", Params: params}, false, newChannelTracker(client))
		raw, _ := json.Marshal(response["result"])
		var result map[string]any
		_ = json.Unmarshal(raw, &result)
		return result
	}
	result := call("resource_claim_acquire", map[string]any{"client_request_id": "00000000-0000-4000-8000-000000000001", "purpose": "test", "resources": []any{map[string]any{"kind": "path", "path": "/tmp/x"}}})
	content, _ := result["content"].([]any)
	if result["isError"] != true || len(content) != 2 {
		t.Fatalf("claim error lost its details: %v", result)
	}
	if first, _ := content[0].(map[string]any); !strings.Contains(first["text"].(string), "(claim_connection_required)") {
		t.Fatalf("readable error text changed: %v", first)
	}
	structured, _ := result["structuredContent"].(map[string]any)
	failure, _ := structured["error"].(map[string]any)
	connection, _ := failure["claim_connection"].(map[string]any)
	if failure["code"] != "claim_connection_required" || connection["proof_state"] != "client_too_old" || failure["status"] != nil {
		t.Fatalf("structured error missing claim_connection: %v", structured)
	}
	second, _ := content[1].(map[string]any)
	if !strings.Contains(second["text"].(string), `"proof_state":"client_too_old"`) {
		t.Fatalf("model-visible text lacks the diagnosis: %v", second)
	}
	plain := call("agent_context_get", map[string]any{})
	if items, _ := plain["content"].([]any); plain["isError"] != true || len(items) != 1 || plain["structuredContent"] != nil {
		t.Fatalf("plain error changed shape: %v", plain)
	}
}

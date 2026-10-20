package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestWorkflowToolsUseSessionBridgeAndPreserveRequest(t *testing.T) {
	for name, path := range workflowPaths {
		t.Run(name, func(t *testing.T) {
			args := map[string]any{"run_id": "11111111-1111-4111-8111-111111111111", "client_request_id": "22222222-2222-4222-8222-222222222222"}
			for _, status := range []int{200, 409} {
				client := &sessionClient{id: "fixture-session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					if !strings.HasSuffix(req.URL.Path, "/host/agent-sessions/fixture-session/agent-messaging/"+path) {
						t.Fatalf("wrong workflow route %s", req.URL.Path)
					}
					var sent map[string]any
					if err := json.NewDecoder(req.Body).Decode(&sent); err != nil {
						t.Fatal(err)
					}
					if sent["client_request_id"] != args["client_request_id"] || sent["run_id"] != args["run_id"] {
						t.Fatalf("mutation changed: %v", sent)
					}
					return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"report_url":"/admin/workflows/runs/fixture","code":"workflow_claim_lost"}`))}, nil
				})}}
				out, err := callMCPTool(context.Background(), client, newChannelTracker(client), name, args)
				if status == 200 && (err != nil || out["report_url"] == nil) {
					t.Fatalf("lost result: %v %v", out, err)
				}
				if status == 409 && err == nil {
					t.Fatal("lost workflow conflict")
				}
			}
		})
	}
}

func TestWorkflowCatalogIsCompleteAndActionSchemasAreDistinct(t *testing.T) {
	tools := workflowTools()
	if len(tools) != 13 || len(workflowPaths) != 13 {
		t.Fatalf("workflow tool coverage %d/%d", len(tools), len(workflowPaths))
	}
	for _, entry := range tools {
		name := entry["name"].(string)
		if workflowPaths[name] == "" {
			t.Fatalf("missing dispatcher %s", name)
		}
		schema := entry["inputSchema"].(map[string]any)
		if name == "agent_workflow_task_claim" || name == "agent_workflow_task_update" || name == "agent_workflow_membership" || name == "agent_workflow_run_control" {
			variants, ok := schema["oneOf"].([]any)
			if !ok || len(variants) < 3 {
				t.Fatalf("missing action contracts for %s", name)
			}
			for _, variant := range variants {
				if variant.(map[string]any)["additionalProperties"] != false {
					t.Fatalf("actor fields accepted by %s", name)
				}
			}
		} else if schema["additionalProperties"] != false {
			t.Fatalf("open schema %s", name)
		}
	}
}

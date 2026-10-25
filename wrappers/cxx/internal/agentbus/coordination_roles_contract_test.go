package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// Explicit contract table: adding a dispatcher entry requires reviewing its
// route, payload preservation and refusal semantics, not just a generic 200.
func TestCoordinationAndRoleToolsPreserveSessionRequestsAndFences(t *testing.T) {
	routes := map[string]string{
		"agent_chat_list": "chats/list", "agent_chat_read": "chats/read", "agent_chat_send": "chats/send",
		"agent_context_get": "context/get", "agent_context_update": "context/update",
		"agent_room_list": "rooms/list", "agent_room_read": "rooms/read", "agent_room_send": "rooms/send",
		"agent_git_remote": "git/remote", "resource_claim_acquire": "claims/acquire",
		"resource_claim_status": "claims/status", "resource_claim_release": "claims/release",
		"agent_role_activate": "roles/activate", "agent_role_current": "roles/current",
		"agent_role_release": "roles/release", "agent_role_propose": "roles/propose",
		"agent_role_proposals": "roles/proposals", "agent_role_review": "roles/review",
	}
	if len(routes) != len(coordinationPaths)+len(rolePaths) {
		t.Fatal("review new coordination/role dispatchers")
	}
	for name, route := range routes {
		t.Run(name, func(t *testing.T) {
			args := map[string]any{
				"client_request_id": "a9ba60e7-e2ad-4416-a682-88d25d588189",
				"args":              map[string]any{"worktree_path": "/fixture/repo", "branch": "main"},
			}
			for _, status := range []int{200, 409} {
				requests := 0
				client := &sessionClient{id: "fixture-session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					requests++
					if req.Method != http.MethodPost || req.URL.Path != "/host/agent-sessions/fixture-session/agent-messaging/"+route {
						t.Fatalf("wrong session route: %s %s", req.Method, req.URL.Path)
					}
					var sent map[string]any
					if err := json.NewDecoder(req.Body).Decode(&sent); err != nil || !reflect.DeepEqual(sent, args) {
						t.Fatalf("request changed: %#v, %v", sent, err)
					}
					body := `{"marker":"fixture-response"}`
					if status == 409 {
						body = `{"error":{"code":"fixture_fenced","message":"Original owner required"}}`
					}
					return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
				})}}
				out, err := callMCPTool(context.Background(), client, newChannelTracker(client), name, args)
				if status == 200 {
					if err != nil || out["marker"] != "fixture-response" {
						t.Fatalf("lost response: %#v %v", out, err)
					}
				} else {
					var fenced *APIError
					if !errors.As(err, &fenced) || fenced.Status != 409 || fenced.Code != "fixture_fenced" {
						t.Fatalf("lost owner fence: %v", err)
					}
				}
				if requests != 1 {
					t.Fatalf("ambiguous operation replayed: %d requests", requests)
				}
			}
		})
	}
}

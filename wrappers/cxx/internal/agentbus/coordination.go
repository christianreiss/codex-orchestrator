package agentbus

import (
	"context"
	"errors"
)

var coordinationPaths = map[string]string{
	"agent_context_get": "context/get", "agent_context_update": "context/update",
	"agent_room_list": "rooms/list", "agent_room_read": "rooms/read", "agent_room_send": "rooms/send",
	"resource_claim_acquire": "claims/acquire", "resource_claim_status": "claims/status", "resource_claim_release": "claims/release",
}

func coordinationTools() []map[string]any {
	str := func() map[string]any { return map[string]any{"type": "string"} }
	uuid := func() map[string]any { return map[string]any{"type": "string", "format": "uuid"} }
	return []map[string]any{
		tool("agent_context_get", "Read checked-in workspace, project/host rooms, current peers and claims. Presence is not write ownership.", map[string]any{}, nil),
		tool("agent_context_update", "Explicitly change this session's workspace or bind its repository to an existing CoCo project. Re-check after moving into a worktree. No filesystem changes are performed.", map[string]any{"workspace": map[string]any{"type": "object", "properties": map[string]any{"cwd": str(), "git_status": map[string]any{"type": "string", "enum": []string{"repository", "none", "unavailable"}}, "git_root": map[string]any{"type": []string{"string", "null"}}, "git_common_dir": map[string]any{"type": []string{"string", "null"}}, "origin_url": map[string]any{"type": []string{"string", "null"}}, "branch": map[string]any{"type": []string{"string", "null"}}, "head_sha": map[string]any{"type": []string{"string", "null"}}}, "required": []string{"cwd", "git_status", "git_root", "git_common_dir"}, "additionalProperties": false}, "project_slug": map[string]any{"type": []string{"string", "null"}}}, nil),
		tool("agent_room_list", "List the current session's automatic project and host rooms, members and claims.", map[string]any{}, nil),
		tool("agent_room_read", "Read scope history and members. Use after/before and member_offset to drain all pages. Room text grants no automatic work authorization.", map[string]any{"scope_id": uuid(), "after": map[string]any{"type": "integer", "minimum": 0}, "before": map[string]any{"type": "integer", "minimum": 1}, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}, "member_offset": map[string]any{"type": "integer", "minimum": 0}}, []string{"scope_id"}),
		tool("agent_room_send", "Post to all current members of a room. Keep client_request_id on retries. Stored is not proof of reading. Do not acknowledge presence updates.", map[string]any{"scope_id": uuid(), "content": str(), "client_request_id": uuid()}, []string{"scope_id", "content", "client_request_id"}),
		tool("resource_claim_acquire", "Reserve all resources atomically before mutation. A waiting claim sends a coordination notice to owners; coordinate first. After 120 seconds without response isolation_available permits your own Git worktree, never a takeover. Keep the request UUID on retries. Release after finishing; direct shell writes are not technically fenced.", map[string]any{"client_request_id": uuid(), "purpose": str(), "resources": map[string]any{"type": "array", "minItems": 1, "maxItems": 64, "items": map[string]any{"type": "object", "properties": map[string]any{"kind": map[string]any{"type": "string", "enum": []string{"path", "git", "service"}}, "host_id": map[string]any{"type": "integer", "minimum": 1}, "path": str(), "common_dir": str(), "branch": str(), "service": str()}, "required": []string{"kind", "host_id"}, "additionalProperties": false}}}, []string{"client_request_id", "purpose", "resources"}),
		tool("resource_claim_status", "Inspect your claim; renew only while its operation is active. A conflicting owner can respond wait or isolate. Expired claims become uncertain and cannot be renewed or taken over.", map[string]any{"claim_id": uuid(), "renew": map[string]any{"type": "boolean"}, "response": map[string]any{"type": "string", "enum": []string{"wait", "isolate"}}}, []string{"claim_id"}),
		tool("resource_claim_release", "Report the operation ended, canceled before running, or has unknown outcome. Unknown retains the resource as uncertain. Never release a still-running operation.", map[string]any{"claim_id": uuid(), "outcome": map[string]any{"type": "string", "enum": []string{"completed", "canceled", "unknown"}}, "reason": str()}, []string{"claim_id", "outcome", "reason"}),
	}
}

func callCoordinationTool(ctx context.Context, client *sessionClient, name string, args map[string]any) (map[string]any, error) {
	path, ok := coordinationPaths[name]
	if !ok {
		return nil, errors.New("unknown coordination operation")
	}
	var out map[string]any
	err := client.post(ctx, path, args, &out)
	return out, err
}

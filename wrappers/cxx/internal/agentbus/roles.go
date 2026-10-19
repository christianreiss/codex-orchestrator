package agentbus

import (
	"context"
	"errors"
)

// Agent roles ride the bridge because activation, proposals and reviews need
// the caller's own identity; the catalog (role_list) and role:// content are
// served by the orchestrator MCP.
var rolePaths = map[string]string{
	"agent_role_activate":  "roles/activate",
	"agent_role_current":   "roles/current",
	"agent_role_release":   "roles/release",
	"agent_role_propose":   "roles/propose",
	"agent_role_proposals": "roles/proposals",
	"agent_role_review":    "roles/review",
}

func roleTools() []map[string]any {
	str := func() map[string]any { return map[string]any{"type": "string"} }
	uuid := func() map[string]any { return map[string]any{"type": "string", "format": "uuid"} }
	op := map[string]any{"type": "object", "additionalProperties": false, "required": []string{"op", "path"}, "properties": map[string]any{
		"op":          map[string]any{"type": "string", "enum": []string{"put", "delete"}},
		"path":        str(),
		"content":     str(),
		"encoding":    map[string]any{"type": "string", "enum": []string{"utf8", "base64"}},
		"mime_type":   str(),
		"load":        map[string]any{"type": "string", "enum": []string{"core", "on_demand"}},
		"description": str(),
		"base_sha256": map[string]any{"type": []string{"string", "null"}},
	}}
	return []map[string]any{
		tool("agent_role_activate", "Activate a fleet role for this session, only on an explicit assignment (read the roles Skill first). Returns the pinned version's manifest, core files, file index and declared tools; confirm role, version and sha to the user. replace:true switches roles only on your principal's instruction; activated_by:self_upgrade moves to a newer version of the same role at a task boundary. A role grants no access rights or tools.", map[string]any{
			"role": str(), "version": map[string]any{"oneOf": []any{map[string]any{"type": "string", "enum": []string{"latest"}}, map[string]any{"type": "integer", "minimum": 1}}},
			"reason": str(), "replace": map[string]any{"type": "boolean"}, "client_request_id": uuid(),
			"activated_by": map[string]any{"type": "string", "enum": []string{"operator_prompt", "portal", "spawn", "peer", "self_upgrade"}},
			"peer_address": str(), "message_id": uuid(),
		}, []string{"role", "reason", "client_request_id"}),
		tool("agent_role_current", "Show this session's active role and pinned version. After a resume or compaction call it with include_core:true and work from the returned instructions; it never switches versions.", map[string]any{"include_core": map[string]any{"type": "boolean"}}, nil),
		tool("agent_role_release", "End this session's role, only on your principal's explicit instruction.", map[string]any{"reason": str()}, []string{"reason"}),
		tool("agent_role_propose", "Propose a general improvement to the role you hold: reference, snippet, checklist line, note, role-prompt change or a revert. The server computes the risk, checks and judges it and, for changes to existing content, asks another holder before it publishes a new version itself. Project-specific decisions belong in project records, never here.", map[string]any{
			"kind":  map[string]any{"type": "string", "enum": []string{"file_add", "file_change", "file_remove", "manifest_change", "note", "revert"}},
			"title": str(), "rationale": str(),
			"evidence":          map[string]any{"type": "array", "maxItems": 20},
			"ops":               map[string]any{"type": "array", "maxItems": 50, "items": op},
			"revert_to_version": map[string]any{"type": "integer", "minimum": 1},
			"client_request_id": uuid(),
		}, []string{"kind", "title", "rationale", "client_request_id"}),
		tool("agent_role_proposals", "List your own role proposals and the open, unreviewed ones for your role, or read one in full (with bodies and its event trail) by proposal_id. Unreviewed content is not part of the role.", map[string]any{"proposal_id": uuid(), "status": str()}, nil),
		tool("agent_role_review", "Answer a ROLE-REVIEW/1 request: accept, reject or revise another holder's proposal to the role you hold, citing the change itself. You cannot review your own proposal.", map[string]any{
			"proposal_id": uuid(), "verdict": map[string]any{"type": "string", "enum": []string{"accept", "reject", "revise"}},
			"reason": str(), "expected_version": map[string]any{"type": "integer", "minimum": 1},
		}, []string{"proposal_id", "verdict", "reason", "expected_version"}),
	}
}

func callRoleTool(ctx context.Context, client *sessionClient, name string, args map[string]any) (map[string]any, error) {
	path, ok := rolePaths[name]
	if !ok {
		return nil, errors.New("unknown role operation")
	}
	var out map[string]any
	err := client.post(ctx, path, args, &out)
	return out, err
}

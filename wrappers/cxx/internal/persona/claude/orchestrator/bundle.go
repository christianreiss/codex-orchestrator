// Package orchestrator — bundle.go (clx mirror) defines the typed shape for
// /sync/bootstrap. Server-side contract is engine-aware (engine=claude maps
// to the Anthropic auth retriever): api/src/routes/auth/index.ts:127-153.
package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
)

// BundleRequest is the POST body for /sync/bootstrap.
type BundleRequest struct {
	Engine        string          `json:"engine"`
	IncludeAuth   bool            `json:"include_auth"`
	AuthDigest    string          `json:"auth_digest,omitempty"`
	AuthCandidate json.RawMessage `json:"auth_candidate,omitempty"`
	Agents        string          `json:"agents,omitempty"`
	Config        string          `json:"config,omitempty"`
	Home          string          `json:"home,omitempty"`
	Username      string          `json:"username,omitempty"`
	// Artifacts carries the wrapper's on-disk per-collection digests
	// (kind -> slug -> sha256) so the server can omit `content` for unchanged
	// items. Shape: {"subagent": {"reviewer": "<sha>"}, "command": {…}, …}.
	Artifacts map[string]map[string]string `json:"artifacts,omitempty"`
}

// CollectionFile is one auxiliary file in a directory-backed skill bundle.
// Paths are slash-separated and relative to the skill directory. The wrapper
// validates them again before writing; imported content is never executed.
type CollectionFile struct {
	Path    string `json:"path"`
	SHA256  string `json:"sha256"`
	Content string `json:"content"`
}

// CollectionItem is one Claude-native collection artifact. Flat collections
// use Content only; skills may additionally carry their complete auxiliary file
// tree. Content/files are omitted together on If-None-Match.
type CollectionItem struct {
	Slug           string           `json:"slug"`
	SHA256         string           `json:"sha256"`
	Status         string           `json:"status"`
	Content        string           `json:"content,omitempty"`
	ManifestSHA256 string           `json:"manifest_sha256,omitempty"`
	Files          []CollectionFile `json:"files,omitempty"`
}

// ClaudeArtifacts groups the three collection kinds returned by /sync/bootstrap
// for Claude hosts. Each list is the COMPLETE live set so the wrapper can
// reconcile deletions against its on-disk manifest.
type ClaudeArtifacts struct {
	Subagents    []CollectionItem `json:"subagent"`
	Commands     []CollectionItem `json:"command"`
	OutputStyles []CollectionItem `json:"output-style"`
}

// ClaudeSettings is the deep-merge partial for ~/.claude/settings.json: only the
// fleet-managed keys, plus OwnedPaths (leaf dot-paths the fleet owns) so the
// wrapper can add/update/remove exactly those without clobbering user keys.
type ClaudeSettings struct {
	Status     string          `json:"status"`
	SHA256     string          `json:"sha256,omitempty"`
	Partial    json.RawMessage `json:"partial,omitempty"`
	OwnedPaths []string        `json:"owned_paths,omitempty"`
}

// BundleResponse matches the envelope returned by /sync/bootstrap. Auth block,
// when present, is the same shape as a standalone /auth retrieve.
type BundleResponse struct {
	Status          string                `json:"status"`
	Reasons         []string              `json:"reasons,omitempty"`
	Auth            *AuthRetrieveResponse `json:"auth,omitempty"`
	Agents          json.RawMessage       `json:"agents,omitempty"`
	Config          json.RawMessage       `json:"config,omitempty"`
	Host            *HostInfo             `json:"host,omitempty"`
	ClaudeArtifacts *ClaudeArtifacts      `json:"claude_artifacts,omitempty"`
	ClaudeSettings  *ClaudeSettings       `json:"claude_settings,omitempty"`
	// ClaudeSkills is the COMPLETE live set of fleet skills rendered as Claude
	// Code SKILL.md files for on-disk install at ~/.claude/skills/<slug>/SKILL.md
	// (Claude Code can't read skills over MCP). Content omitted on sha match.
	ClaudeSkills []CollectionItem `json:"claude_skills,omitempty"`
	Sessions     *FleetSessions   `json:"sessions,omitempty"`
}

// FleetSessions is the historical response name for the same recent-host and
// UTC sync-activity counters exposed to cdx. Nil hides the block for an older
// server.
type FleetSessions struct {
	Now   int64 `json:"now"`
	Today int64 `json:"today"`
	Month int64 `json:"month"`
}

// SyncBootstrap calls POST /sync/bootstrap. On 404/501 the caller is expected
// to detect that string in the returned error and fall back to per-resource
// pulls.
func (c *Client) SyncBootstrap(ctx context.Context, req BundleRequest) (*BundleResponse, error) {
	if req.Engine == "" {
		req.Engine = "claude"
	}
	var raw json.RawMessage
	if err := c.JSON(ctx, http.MethodPost, "/sync/bootstrap", req, &raw, 2); err != nil {
		return nil, err
	}
	out, err := decodeBundleResponse(raw)
	if err != nil {
		return nil, err
	}
	if err := out.unwrapResources(); err != nil {
		return nil, err
	}
	return out, nil
}

func decodeBundleResponse(raw json.RawMessage) (*BundleResponse, error) {
	var env struct {
		Status string          `json:"status"`
		Data   json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}

	body := raw
	if len(env.Data) > 0 && string(env.Data) != "null" {
		body = env.Data
	}

	out := &BundleResponse{}
	if err := json.Unmarshal(body, out); err != nil {
		return nil, err
	}
	if out.Status == "" {
		out.Status = env.Status
	}
	return out, nil
}

func (r *BundleResponse) unwrapResources() error {
	var err error
	r.Agents, err = resourceContent(r.Agents)
	if err != nil {
		return err
	}
	r.Config, err = resourceContent(r.Config)
	if err != nil {
		return err
	}
	return nil
}

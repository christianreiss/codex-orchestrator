// Package orchestrator — bundle.go contains the typed shape for the startup
// bundle endpoint (`/sync/bootstrap`) used by lifecycle.Run as the fast path.
// Server-side contract: api/src/routes/auth/index.ts:127-153.
//
// The bundle response carries the full auth payload plus the AGENTS/config
// bodies in a single round-trip, so a cold boot drops from three POSTs to one.
// When the server is older than the bundle endpoint (404/501), the lifecycle
// falls back to the per-resource pulls.
package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
)

// BundleRequest is the POST body for /sync/bootstrap.
//
//   - Engine        — "codex" or "claude".
//   - IncludeAuth   — when true, the server inlines the auth retrieve result.
//   - AuthDigest    — SHA256 of the local auth.json; lets the server skip
//     re-sending an unchanged payload.
//   - AuthCandidate — optional local auth.json bytes that the wrapper offers
//     for upload when status is `missing`/`upload_required`.
//   - Agents/Config — local SHA256 digests for the matching docs.
type BundleRequest struct {
	Engine        string          `json:"engine"`
	IncludeAuth   bool            `json:"include_auth"`
	AuthDigest    string          `json:"auth_digest,omitempty"`
	AuthCandidate json.RawMessage `json:"auth_candidate,omitempty"`
	Agents        string          `json:"agents,omitempty"`
	Config        string          `json:"config,omitempty"`
	Home          string          `json:"home,omitempty"`
	Username      string          `json:"username,omitempty"`
}

// BundleResponse matches the envelope returned by /sync/bootstrap. The auth
// block, when present, is the same shape as a standalone /auth retrieve.
//
// Note: the server never sets a top-level `host` key on this envelope — host
// info only ever arrives nested under Auth.Host (see auth.go's HostInfo).
// There is intentionally no Host field here; don't add one back without
// confirming the server side actually populates it.
type BundleResponse struct {
	Status   string                `json:"status"`
	Reasons  []string              `json:"reasons,omitempty"`
	Auth     *AuthRetrieveResponse `json:"auth,omitempty"`
	Agents   json.RawMessage       `json:"agents,omitempty"`
	Config   json.RawMessage       `json:"config,omitempty"`
	Sessions *FleetSessions        `json:"sessions,omitempty"`
}

// FleetSessions carries the boot-screen "sessions" counts derived server-side
// from the logs table. Nil-safe — older servers omit the block entirely and
// the wrapper renders nothing in that case.
//
//   - Now    — distinct hosts with a cdx-run start in the last 30 minutes
//   - Today  — total cdx-run starts across the fleet today (UTC day)
//   - Month  — total cdx-run starts across the fleet this calendar month (UTC)
type FleetSessions struct {
	Now   int64 `json:"now"`
	Today int64 `json:"today"`
	Month int64 `json:"month"`
}

// SyncBootstrap calls POST /sync/bootstrap with the typed payload above. The
// caller is expected to check err for the "404" / "501" suffix on a fallback
// path; we don't add typed status codes because client.JSON() embeds them in
// the error string already (e.g. "POST /sync/bootstrap -> 404: …").
func (c *Client) SyncBootstrap(ctx context.Context, req BundleRequest) (*BundleResponse, error) {
	if req.Engine == "" {
		req.Engine = "codex"
	}
	out := &BundleResponse{}
	if err := c.JSON(ctx, http.MethodPost, "/sync/bootstrap", req, out, 2); err != nil {
		return nil, err
	}
	if err := out.unwrapResources(); err != nil {
		return nil, err
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

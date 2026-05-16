package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// AuthRetrieveResponse mirrors the legacy /auth?command=retrieve shape.
// Unknown fields are tolerated so the orchestrator can evolve fields.
type AuthRetrieveResponse struct {
	Status  string          `json:"status"`
	Message string          `json:"message,omitempty"`
	Digest  string          `json:"digest,omitempty"`
	Auth    json.RawMessage `json:"auth,omitempty"`
}

// AuthRetrieve calls POST /auth with command=retrieve.
// digest is the SHA256 of the locally-cached auth.json; the server returns
// status=current (no body), status=outdated (with auth payload), or status=missing.
func (c *Client) AuthRetrieve(ctx context.Context, digest string) (*AuthRetrieveResponse, error) {
	body := map[string]any{
		"command": "retrieve",
		"engine":  "codex",
	}
	if digest != "" {
		body["digest"] = digest
	}
	out := &AuthRetrieveResponse{}
	if err := c.JSON(ctx, http.MethodPost, "/auth", body, out, 1); err != nil {
		return nil, err
	}
	if out.Status == "error" {
		return out, fmt.Errorf("auth retrieve: %s", out.Message)
	}
	return out, nil
}

// AuthStore uploads an auth payload (used by `cdx auth upload` flows).
func (c *Client) AuthStore(ctx context.Context, payload json.RawMessage) error {
	body := map[string]any{
		"command": "store",
		"engine":  "codex",
		"auth":    payload,
	}
	out := &AuthRetrieveResponse{}
	if err := c.JSON(ctx, http.MethodPost, "/auth", body, out, 1); err != nil {
		return err
	}
	if out.Status == "error" {
		return errors.New(out.Message)
	}
	return nil
}

// SyncStatus mirrors POST /sync/status — small object with lane / version hints.
type SyncStatus struct {
	Status string         `json:"status"`
	Data   map[string]any `json:"data,omitempty"`
}

func (c *Client) SyncStatus(ctx context.Context) (*SyncStatus, error) {
	out := &SyncStatus{}
	if err := c.JSON(ctx, http.MethodPost, "/sync/status", map[string]any{"engine": "codex"}, out, 1); err != nil {
		return nil, err
	}
	return out, nil
}

// SyncBootstrap is the first-contact handshake.
func (c *Client) SyncBootstrap(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	if err := c.JSON(ctx, http.MethodPost, "/sync/bootstrap", map[string]any{"engine": "codex"}, &out, 2); err != nil {
		return nil, err
	}
	return out, nil
}

package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// AuthRetrieveResponse mirrors POST /auth?engine=claude.
type AuthRetrieveResponse struct {
	Status  string          `json:"status"`
	Message string          `json:"message,omitempty"`
	Digest  string          `json:"digest,omitempty"`
	Auth    json.RawMessage `json:"auth,omitempty"`
}

func (c *Client) AuthRetrieve(ctx context.Context, digest string) (*AuthRetrieveResponse, error) {
	body := map[string]any{
		"command": "retrieve",
		"engine":  "claude",
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

func (c *Client) AuthStore(ctx context.Context, payload json.RawMessage) error {
	body := map[string]any{
		"command": "store",
		"engine":  "claude",
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

type SyncStatus struct {
	Status string         `json:"status"`
	Data   map[string]any `json:"data,omitempty"`
}

func (c *Client) SyncStatus(ctx context.Context) (*SyncStatus, error) {
	out := &SyncStatus{}
	if err := c.JSON(ctx, http.MethodPost, "/sync/status", map[string]any{"engine": "claude"}, out, 1); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) SyncBootstrap(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	if err := c.JSON(ctx, http.MethodPost, "/sync/bootstrap", map[string]any{"engine": "claude"}, &out, 2); err != nil {
		return nil, err
	}
	return out, nil
}

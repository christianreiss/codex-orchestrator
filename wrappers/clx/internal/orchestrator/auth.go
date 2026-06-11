package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// AuthRetrieveResponse mirrors POST /auth?engine=claude. The orchestrator may
// add fields freely; unknown fields are tolerated.
type AuthRetrieveResponse struct {
	Status               string          `json:"status"`
	Action               string          `json:"action,omitempty"`
	Message              string          `json:"message,omitempty"`
	Digest               string          `json:"digest,omitempty"`
	CanonicalDigest      string          `json:"canonical_digest,omitempty"`
	CanonicalLastRefresh string          `json:"canonical_last_refresh,omitempty"`
	Auth                 json.RawMessage `json:"auth,omitempty"`
	APICalls             int64           `json:"api_calls,omitempty"`
	Versions             *VersionSummary `json:"versions,omitempty"`
	Host                 *HostInfo       `json:"host,omitempty"`
	QuotaHardFail        bool            `json:"quota_hard_fail,omitempty"`
	QuotaLimitPercent    *int            `json:"quota_limit_percent,omitempty"`
	Engine               string          `json:"engine,omitempty"`
	VerificationState    string          `json:"verification_state,omitempty"`
	RunnerApplied        bool            `json:"runner_applied,omitempty"`
	RunnerSkippedReason  string          `json:"runner_skipped_reason,omitempty"`
}

type VersionSummary struct {
	ClientVersion             *string `json:"client_version"`
	ClientVersionOverride     *string `json:"client_version_override"`
	ClientVersionEnforceExact bool    `json:"client_version_enforce_exact"`
	WrapperVersion            *string `json:"wrapper_version"`
	WrapperSHA256             *string `json:"wrapper_sha256"`
	WrapperURL                *string `json:"wrapper_url"`
	RunnerState               *string `json:"runner_state"`
	APIDisabled               bool    `json:"api_disabled"`
	AutoUpdateEnabled         bool    `json:"auto_update_enabled"`
	CdxSilent                 bool    `json:"cdx_silent"`
	ClxSilent                 bool    `json:"clx_silent"`
	InstallationID            *string `json:"installation_id"`
	Engine                    string  `json:"engine,omitempty"`
}

type HostInfo struct {
	FQDN                 string   `json:"fqdn"`
	Status               string   `json:"status"`
	ClaudeLastRefresh    string   `json:"claude_last_refresh,omitempty"`
	UpdatedAt            string   `json:"updated_at,omitempty"`
	ExpiresAt            string   `json:"expires_at,omitempty"`
	ClaudeClientVersion  string   `json:"claude_client_version,omitempty"`
	ClaudeWrapperVersion string   `json:"claude_wrapper_version,omitempty"`
	APICalls             int64    `json:"api_calls,omitempty"`
	Secure               bool     `json:"secure"`
	Vip                  bool     `json:"vip,omitempty"`
	ClaudeModelOverride  string   `json:"claude_model_override,omitempty"`
	ReasoningEffort      string   `json:"claude_reasoning_effort_override,omitempty"`
	AutoUpdateOverride   *bool    `json:"auto_update_override,omitempty"`
	LastCronCheck        string   `json:"last_cron_check,omitempty"`
	Engines              string   `json:"engines,omitempty"`
	EnginesList          []string `json:"engines_list,omitempty"`
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
		// An insecure host awaiting (or refused) operator approval answers with
		// 423/403, not a transport failure. Surface it as the corresponding auth
		// status so the launch gate enters the approval poll instead of treating
		// a live API as "offline".
		if st := InsecureStatusFromError(err); st != "" {
			return &AuthRetrieveResponse{Status: st}, nil
		}
		var he *HTTPError
		if errors.As(err, &he) && he.Code == "engine_disabled" {
			return &AuthRetrieveResponse{Status: "disabled", Message: "engine disabled for this host"}, nil
		}
		return nil, err
	}
	if out.Status == "error" {
		return out, fmt.Errorf("auth retrieve: %s", out.Message)
	}
	return out, nil
}

func (c *Client) AuthStore(ctx context.Context, payload json.RawMessage) (*AuthRetrieveResponse, error) {
	body := map[string]any{
		"command": "store",
		"engine":  "claude",
		"auth":    payload,
	}
	out := &AuthRetrieveResponse{}
	if err := c.JSON(ctx, http.MethodPost, "/auth", body, out, 1); err != nil {
		return nil, err
	}
	if out.Status == "error" {
		return out, errors.New(out.Message)
	}
	return out, nil
}

// CheckAuthStatus runs /auth retrieve and returns just the lower-cased
// status + a free-form reason string. Used by ui.PollApproval as the polling
// callback (the UI package does not depend on this concrete client type;
// PollApproval takes a minimal interface).
func (c *Client) CheckAuthStatus(ctx context.Context) (string, string, error) {
	resp, err := c.AuthRetrieve(ctx, "")
	if err != nil {
		return "", "", err
	}
	reason := resp.Message
	if reason == "" {
		reason = resp.Action
	}
	return strings.ToLower(strings.TrimSpace(resp.Status)), reason, nil
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

// SyncBootstrap is implemented in bundle.go (typed request + response).

package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// AuthRetrieveResponse mirrors POST /auth retrieve. The orchestrator may add
// fields freely; unknown fields are tolerated. The legacy bash wrapper consumed
// ~30 side-channel fields here — they're now strongly typed so the boot
// banner, health dots, and quota panel can read them without re-parsing JSON.
type AuthRetrieveResponse struct {
	Status               string          `json:"status"`
	Action               string          `json:"action,omitempty"`
	Message              string          `json:"message,omitempty"`
	Digest               string          `json:"digest,omitempty"`
	CanonicalDigest      string          `json:"canonical_digest,omitempty"`
	CanonicalLastRefresh string          `json:"canonical_last_refresh,omitempty"`
	Auth                 json.RawMessage `json:"auth,omitempty"`
	APICalls             int64           `json:"api_calls,omitempty"`
	TokenUsageMonth      *TokenUsage     `json:"token_usage_month,omitempty"`
	Versions             *VersionSummary `json:"versions,omitempty"`
	Host                 *HostInfo       `json:"host,omitempty"`
	ChatGPT              *ChatGPTQuota   `json:"chatgpt,omitempty"`
	QuotaHardFail        bool            `json:"quota_hard_fail,omitempty"`
	QuotaLimitPercent    *int            `json:"quota_limit_percent,omitempty"`
	Engine               string          `json:"engine,omitempty"`
	VerificationState    string          `json:"verification_state,omitempty"`
}

// TokenUsage is the rolling month-to-date token tally for this host.
type TokenUsage struct {
	Total     int64 `json:"total"`
	Input     int64 `json:"input"`
	Output    int64 `json:"output"`
	Cached    int64 `json:"cached"`
	Reasoning int64 `json:"reasoning"`
}

// VersionSummary mirrors VersionSnapshot on the server.
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

// HostInfo mirrors the host block returned in /auth retrieve.
type HostInfo struct {
	FQDN                  string `json:"fqdn"`
	Status                string `json:"status"`
	LastRefresh           string `json:"last_refresh,omitempty"`
	UpdatedAt             string `json:"updated_at,omitempty"`
	ExpiresAt             string `json:"expires_at,omitempty"`
	ClientVersion         string `json:"client_version,omitempty"`
	ClientVersionOverride string `json:"client_version_override,omitempty"`
	WrapperVersion        string `json:"wrapper_version,omitempty"`
	APICalls              int64  `json:"api_calls,omitempty"`
	AllowRoamingIps       bool   `json:"allow_roaming_ips,omitempty"`
	Secure                bool   `json:"secure"`
	Vip                   bool   `json:"vip,omitempty"`
	LanePreference        string `json:"lane_preference,omitempty"`
	ModelOverride         string `json:"model_override,omitempty"`
	ReasoningEffort       string `json:"reasoning_effort_override,omitempty"`
	AutoUpdateOverride    *bool  `json:"auto_update_override,omitempty"`
	LastCronCheck         string `json:"last_cron_check,omitempty"`
}

// ChatGPTQuota is the per-host ChatGPT usage snapshot. All percent fields are
// 0-100 ints (or nil if the server has no current data).
type ChatGPTQuota struct {
	Status      string `json:"status,omitempty"`
	PlanType    string `json:"plan_type,omitempty"`
	FetchedAt   string `json:"fetched_at,omitempty"`
	SparkLimit  string `json:"spark_limit_name,omitempty"`
	SparkFeat   string `json:"spark_metered_feature,omitempty"`
	ActiveLane  string `json:"active_quota_lane,omitempty"`
	DailyUsed   *int   `json:"daily_used_percent,omitempty"`
	WeekPart    *int   `json:"week_partition,omitempty"`

	PrimaryUsed       *int   `json:"primary_used_percent,omitempty"`
	PrimaryLimitSec   *int64 `json:"primary_limit_seconds,omitempty"`
	PrimaryResetAfter *int64 `json:"primary_reset_after_seconds,omitempty"`
	PrimaryResetAt    string `json:"primary_reset_at,omitempty"`

	SecondaryUsed       *int   `json:"secondary_used_percent,omitempty"`
	SecondaryLimitSec   *int64 `json:"secondary_limit_seconds,omitempty"`
	SecondaryResetAfter *int64 `json:"secondary_reset_after_seconds,omitempty"`
	SecondaryResetAt    string `json:"secondary_reset_at,omitempty"`

	SparkPrimaryUsed       *int   `json:"spark_primary_used_percent,omitempty"`
	SparkPrimaryLimitSec   *int64 `json:"spark_primary_limit_seconds,omitempty"`
	SparkPrimaryResetAfter *int64 `json:"spark_primary_reset_after_seconds,omitempty"`
	SparkPrimaryResetAt    string `json:"spark_primary_reset_at,omitempty"`

	SparkSecondaryUsed       *int   `json:"spark_secondary_used_percent,omitempty"`
	SparkSecondaryLimitSec   *int64 `json:"spark_secondary_limit_seconds,omitempty"`
	SparkSecondaryResetAfter *int64 `json:"spark_secondary_reset_after_seconds,omitempty"`
	SparkSecondaryResetAt    string `json:"spark_secondary_reset_at,omitempty"`
}

// AuthRetrieve calls POST /auth with command=retrieve.
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

// AuthStore uploads an auth payload (used by `cdx auth-upload`).
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

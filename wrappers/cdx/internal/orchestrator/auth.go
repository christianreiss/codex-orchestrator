package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
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
	CanonicalGeneration  int64           `json:"canonical_generation,omitempty"`
	CandidateResult      string          `json:"candidate_result,omitempty"`
	Auth                 json.RawMessage `json:"auth,omitempty"`
	APICalls             int64           `json:"api_calls,omitempty"`
	Versions             *VersionSummary `json:"versions,omitempty"`
	Host                 *HostInfo       `json:"host,omitempty"`
	ChatGPT              *ChatGPTQuota   `json:"chatgpt,omitempty"`
	QuotaHardFail        bool            `json:"quota_hard_fail,omitempty"`
	QuotaLimitPercent    *int            `json:"quota_limit_percent,omitempty"`
	Engine               string          `json:"engine,omitempty"`
	VerificationState    string          `json:"verification_state,omitempty"`
	// CandidateRejectedDefinitive is emitted only when the server has
	// authoritatively rejected the submitted local candidate and is returning
	// its verified canonical fallback. It is the sole override for a newer
	// locally usable generation.
	CandidateRejectedDefinitive bool `json:"candidate_rejected_definitive,omitempty"`
	// CandidateCredentialRejected says the exact submitted candidate failed
	// live provider verification. Unlike CandidateRejectedDefinitive, this
	// signal alone never authorizes an older canonical to overwrite local auth.
	CandidateCredentialRejected bool `json:"candidate_credential_rejected,omitempty"`
}

// AuthCandidateAccepted reports whether the server accepted the exact auth
// generation carried by an AuthStore request. An "outdated" response is a
// successful arbitration response, but its canonical generation won instead.
func (r *AuthRetrieveResponse) AuthCandidateAccepted() bool {
	if r == nil ||
		r.CandidateRejectedDefinitive ||
		r.CandidateCredentialRejected ||
		!strings.EqualFold(strings.TrimSpace(r.VerificationState), "verified") {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(r.Status)) {
	case "valid", "updated":
		return true
	default:
		return false
	}
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
	FQDN                  string   `json:"fqdn"`
	Status                string   `json:"status"`
	LastRefresh           string   `json:"last_refresh,omitempty"`
	UpdatedAt             string   `json:"updated_at,omitempty"`
	ExpiresAt             string   `json:"expires_at,omitempty"`
	ClientVersion         string   `json:"client_version,omitempty"`
	ClientVersionOverride string   `json:"client_version_override,omitempty"`
	WrapperVersion        string   `json:"wrapper_version,omitempty"`
	APICalls              int64    `json:"api_calls,omitempty"`
	AllowRoamingIps       bool     `json:"allow_roaming_ips,omitempty"`
	Secure                bool     `json:"secure"`
	Vip                   bool     `json:"vip,omitempty"`
	BrowserOSMCPEnabled   bool     `json:"browseros_mcp_enabled,omitempty"`
	LanePreference        string   `json:"lane_preference,omitempty"`
	ModelOverride         string   `json:"model_override,omitempty"`
	ReasoningEffort       string   `json:"reasoning_effort_override,omitempty"`
	AutoUpdateOverride    *bool    `json:"auto_update_override,omitempty"`
	LastCronCheck         string   `json:"last_cron_check,omitempty"`
	Engines               string   `json:"engines,omitempty"`
	EnginesList           []string `json:"engines_list,omitempty"`
}

// ChatGPTQuota is the per-host ChatGPT usage snapshot. All percent fields are
// 0-100 ints (or nil if the server has no current data).
type ChatGPTQuota struct {
	Status     string `json:"status,omitempty"`
	PlanType   string `json:"plan_type,omitempty"`
	FetchedAt  string `json:"fetched_at,omitempty"`
	SparkLimit string `json:"spark_limit_name,omitempty"`
	SparkFeat  string `json:"spark_metered_feature,omitempty"`
	ActiveLane string `json:"active_quota_lane,omitempty"`
	// Pointer booleans preserve the difference between an older response that
	// omitted provider gate state and an explicit provider-side denial.
	RateAllowed           *bool `json:"rate_allowed,omitempty"`
	RateLimitReached      *bool `json:"rate_limit_reached,omitempty"`
	SparkRateAllowed      *bool `json:"spark_rate_allowed,omitempty"`
	SparkRateLimitReached *bool `json:"spark_rate_limit_reached,omitempty"`
	DailyUsed             *int  `json:"daily_used_percent,omitempty"`
	WeekPart              *int  `json:"week_partition,omitempty"`

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

// quotaWindow is one nested window object inside `spark_window` (and the
// normal_window/primary_window siblings). The server emits the spark lane's
// limit/reset values ONLY here — there are no flat `spark_primary_limit_seconds`
// / `spark_primary_reset_after_seconds` root keys — so without reading the
// nested window the spark quota bars lose their reset countdown and projection.
type quotaWindow struct {
	UsedPercent   *int   `json:"used_percent"`
	LimitSec      *int64 `json:"limit_seconds"`
	ResetAfterSec *int64 `json:"reset_after_seconds"`
	ResetAt       string `json:"reset_at"`
}

// UnmarshalJSON decodes the flat ChatGPTQuota fields and then backfills the
// spark lane's limit/reset values from the nested `spark_window` object the
// server actually emits. Implemented at the unmarshal layer so every decode
// path (POST /auth retrieve and the /sync/bootstrap bundle) normalizes
// identically. Flat fields, if a future server ever emits them, win over the
// nested copy.
func (q *ChatGPTQuota) UnmarshalJSON(data []byte) error {
	type alias ChatGPTQuota
	aux := &struct {
		SparkWindow *struct {
			Primary   *quotaWindow `json:"primary_window"`
			Secondary *quotaWindow `json:"secondary_window"`
		} `json:"spark_window"`
		*alias
	}{alias: (*alias)(q)}
	if err := json.Unmarshal(data, aux); err != nil {
		return err
	}
	if aux.SparkWindow != nil {
		fillSparkFromWindow(aux.SparkWindow.Primary, &q.SparkPrimaryUsed, &q.SparkPrimaryLimitSec, &q.SparkPrimaryResetAfter, &q.SparkPrimaryResetAt)
		fillSparkFromWindow(aux.SparkWindow.Secondary, &q.SparkSecondaryUsed, &q.SparkSecondaryLimitSec, &q.SparkSecondaryResetAfter, &q.SparkSecondaryResetAt)
	}
	return nil
}

// fillSparkFromWindow copies the nested window's fields into the flat spark
// targets, but only where the flat value is still unset — so an explicit flat
// field from the server is never clobbered.
func fillSparkFromWindow(win *quotaWindow, used **int, limit **int64, resetAfter **int64, resetAt *string) {
	if win == nil {
		return
	}
	if *used == nil && win.UsedPercent != nil {
		*used = win.UsedPercent
	}
	if *limit == nil && win.LimitSec != nil {
		*limit = win.LimitSec
	}
	if *resetAfter == nil && win.ResetAfterSec != nil {
		*resetAfter = win.ResetAfterSec
	}
	if *resetAt == "" && win.ResetAt != "" {
		*resetAt = win.ResetAt
	}
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

// AuthStore uploads an auth payload and returns the authoritative response.
// The runner may rotate OAuth while validating and return that replacement
// under auth; callers must generation-guard any local materialization.
func (c *Client) AuthStore(ctx context.Context, payload json.RawMessage) (*AuthRetrieveResponse, error) {
	body := map[string]any{
		"command": "store",
		"engine":  "codex",
		"auth":    payload,
	}
	out := &AuthRetrieveResponse{}
	if err := c.JSON(ctx, http.MethodPost, "/auth", body, out, 1); err != nil {
		return nil, err
	}
	if out.Status == "error" {
		return out, errors.New(out.Message)
	}
	switch strings.ToLower(strings.TrimSpace(out.Status)) {
	case "valid", "outdated", "updated":
		return out, nil
	default:
		reason := out.Message
		if reason == "" {
			reason = out.Action
		}
		if reason == "" {
			reason = "server did not accept uploaded auth"
		}
		return out, fmt.Errorf("auth store not accepted: status=%s reason=%s", out.Status, reason)
	}
}

// IsDefinitiveAuthCandidateRejection recognizes only validation-shaped store
// failures. Security policy, approval, installation, and rate-limit 4xx
// responses are deliberately excluded: none proves the candidate credential
// itself is bad.
func IsDefinitiveAuthCandidateRejection(err error) bool {
	var he *HTTPError
	if !errors.As(err, &he) {
		return false
	}
	code := strings.ToLower(strings.TrimSpace(he.Code))
	if he.StatusCode == http.StatusUnprocessableEntity {
		return code == "" || code == "validation_failed"
	}
	return he.StatusCode == http.StatusBadRequest && code == "validation_failed"
}

// IsUnsafeRunnerUpdatedAuthError identifies the one infrastructure response
// that invalidates the pre-request token too: the runner rotated/changed auth
// but returned an unusable replacement. Falling back to the old local token is
// unsafe and usually produces a refresh-token reuse loop.
func IsUnsafeRunnerUpdatedAuthError(err error) bool {
	var he *HTTPError
	return errors.As(err, &he) &&
		he.StatusCode == http.StatusServiceUnavailable &&
		strings.EqualFold(strings.TrimSpace(he.Code), "runner_updated_auth_invalid")
}

// CheckAuthStatus is the minimal shape ui.PollApproval consumes: re-runs
// /auth retrieve and returns just the lower-cased status + a one-line reason
// (the server may surface deny details under message/action). Wraps the
// general retry/timeout machinery in JSON().
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

// SyncBootstrap is implemented in bundle.go (typed request + response).

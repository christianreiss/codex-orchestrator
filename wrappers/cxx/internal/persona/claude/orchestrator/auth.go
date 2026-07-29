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
	Status                      string          `json:"status"`
	Action                      string          `json:"action,omitempty"`
	Message                     string          `json:"message,omitempty"`
	Digest                      string          `json:"digest,omitempty"`
	CanonicalDigest             string          `json:"canonical_digest,omitempty"`
	CanonicalLastRefresh        string          `json:"canonical_last_refresh,omitempty"`
	CanonicalGeneration         int64           `json:"canonical_generation,omitempty"`
	CandidateResult             string          `json:"candidate_result,omitempty"`
	Auth                        json.RawMessage `json:"auth,omitempty"`
	APICalls                    int64           `json:"api_calls,omitempty"`
	Versions                    *VersionSummary `json:"versions,omitempty"`
	Host                        *HostInfo       `json:"host,omitempty"`
	QuotaHardFail               bool            `json:"quota_hard_fail,omitempty"`
	QuotaLimitPercent           *int            `json:"quota_limit_percent,omitempty"`
	Engine                      string          `json:"engine,omitempty"`
	VerificationState           string          `json:"verification_state,omitempty"`
	RunnerApplied               bool            `json:"runner_applied,omitempty"`
	RunnerSkippedReason         string          `json:"runner_skipped_reason,omitempty"`
	CandidateRejectedDefinitive bool            `json:"candidate_rejected_definitive,omitempty"`
	CandidateCredentialRejected bool            `json:"candidate_credential_rejected,omitempty"`
	CandidateMatchesFailedHead  *bool           `json:"candidate_matches_failed_canonical,omitempty"`
}

// HostSecurity reports API-authoritative host security when present. Insecure
// approval statuses are themselves authoritative even when the compact error
// response omits the host object.
func (r *AuthRetrieveResponse) HostSecurity() (secure bool, known bool) {
	if r == nil {
		return false, false
	}
	if r.Host != nil {
		return r.Host.Secure, true
	}
	switch strings.ToLower(strings.TrimSpace(r.Status)) {
	case "insecure", "insecure-denied", "insecure_pending", "insecure_denied":
		return false, true
	default:
		return false, false
	}
}

// AuthCandidateAccepted reports whether the server accepted the exact auth
// candidate carried by an AuthStore or /sync/bootstrap request. In particular,
// an "outdated" response is a successful arbitration response but does not
// acknowledge the candidate: its canonical auth won instead.
func (r *AuthRetrieveResponse) AuthCandidateAccepted() bool {
	if r == nil ||
		r.CandidateRejectedDefinitive ||
		r.CandidateCredentialRejected ||
		!strings.EqualFold(strings.TrimSpace(r.VerificationState), "verified") {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(r.Status)) {
	case "valid", "updated", "current", "ok", "unchanged":
		return true
	default:
		return false
	}
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
	status := strings.ToLower(strings.TrimSpace(out.Status))
	switch status {
	case "updated", "valid":
		return out, nil
	case "outdated":
		// A concurrent/newer canonical won server-side arbitration. This is a
		// successful store outcome only when the server returns that authoritative
		// auth for generation-guarded local application.
		if len(out.Auth) > 0 && out.CanonicalDigest != "" && out.CanonicalLastRefresh != "" {
			return out, nil
		}
	}
	{
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
// responses do not prove that the candidate credential itself is bad.
func IsDefinitiveAuthCandidateRejection(err error) bool {
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	code := strings.ToLower(strings.TrimSpace(httpErr.Code))
	if httpErr.StatusCode == http.StatusUnprocessableEntity {
		return code == "" || code == "validation_failed"
	}
	return httpErr.StatusCode == http.StatusBadRequest && code == "validation_failed"
}

// IsUnsafeRunnerUpdatedAuthError identifies the fail-closed case where the
// runner rotated/changed credentials but returned unusable replacement bytes.
// Reusing the pre-refresh token or starting another login loop is unsafe.
func IsUnsafeRunnerUpdatedAuthError(err error) bool {
	var httpErr *HTTPError
	return errors.As(err, &httpErr) && httpErr.Code == "runner_updated_auth_invalid"
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

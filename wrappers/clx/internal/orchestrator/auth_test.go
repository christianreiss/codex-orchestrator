package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

// decodeAuthRequest reads the POST /auth body the wrapper actually sent.
func decodeAuthRequest(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatalf("read request body: %v", err)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode request body %q: %v", raw, err)
	}
	return body
}

// TestAuthCandidateAcceptedGates pins the credential-arbitration gate: only a
// server-verified acknowledgement of the exact uploaded candidate counts. Every
// other combination must read as "not accepted" so the caller keeps its local
// auth instead of materializing a canonical.
func TestAuthCandidateAcceptedGates(t *testing.T) {
	for _, tc := range []struct {
		name string
		resp *AuthRetrieveResponse
		want bool
	}{
		{name: "nil receiver"},
		{name: "valid verified", resp: &AuthRetrieveResponse{Status: "valid", VerificationState: "verified"}, want: true},
		{name: "updated verified", resp: &AuthRetrieveResponse{Status: "updated", VerificationState: "verified"}, want: true},
		{name: "current verified", resp: &AuthRetrieveResponse{Status: "current", VerificationState: "verified"}, want: true},
		{name: "ok verified", resp: &AuthRetrieveResponse{Status: "ok", VerificationState: "verified"}, want: true},
		{name: "unchanged verified", resp: &AuthRetrieveResponse{Status: "unchanged", VerificationState: "verified"}, want: true},
		{name: "case and padding tolerated", resp: &AuthRetrieveResponse{Status: " Valid ", VerificationState: " VERIFIED "}, want: true},
		{name: "definitive rejection", resp: &AuthRetrieveResponse{Status: "valid", VerificationState: "verified", CandidateRejectedDefinitive: true}},
		{name: "credential rejection", resp: &AuthRetrieveResponse{Status: "valid", VerificationState: "verified", CandidateCredentialRejected: true}},
		{name: "both rejection flags", resp: &AuthRetrieveResponse{Status: "updated", VerificationState: "verified", CandidateRejectedDefinitive: true, CandidateCredentialRejected: true}},
		{name: "verification failed", resp: &AuthRetrieveResponse{Status: "valid", VerificationState: "failed"}},
		{name: "verification pending", resp: &AuthRetrieveResponse{Status: "updated", VerificationState: "pending"}},
		{name: "verification absent", resp: &AuthRetrieveResponse{Status: "valid"}},
		{name: "outdated canonical won", resp: &AuthRetrieveResponse{Status: "outdated", VerificationState: "verified"}},
		{name: "upload required", resp: &AuthRetrieveResponse{Status: "upload_required", VerificationState: "verified"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.resp.AuthCandidateAccepted(); got != tc.want {
				t.Fatalf("AuthCandidateAccepted() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestAuthRetrievePostsClaudeRetrieveCommand pins the request literals: a wrong
// engine value silently arbitrates the other engine's credentials.
func TestAuthRetrievePostsClaudeRetrieveCommand(t *testing.T) {
	var body map[string]any
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		body = decodeAuthRequest(t, r)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "valid"})
	})
	if _, err := c.AuthRetrieve(context.Background(), ""); err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	if body["command"] != "retrieve" || body["engine"] != "claude" {
		t.Fatalf("request body = %#v", body)
	}
	if _, ok := body["digest"]; ok {
		t.Fatalf("empty digest was sent anyway: %#v", body)
	}
}

// TestAuthRetrieveMapsGateErrorsToSyntheticStatus covers the branch that turns
// an approval/kill-switch HTTPError into an auth status instead of a transport
// error, so the launch gate polls for approval rather than declaring the API
// offline. Unrelated HTTPErrors must stay errors.
func TestAuthRetrieveMapsGateErrorsToSyntheticStatus(t *testing.T) {
	for _, tc := range []struct {
		name       string
		httpStatus int
		code       string
		wantStatus string
		wantErr    bool
	}{
		{name: "insecure pending", httpStatus: http.StatusLocked, code: "insecure_pending", wantStatus: "insecure"},
		{name: "insecure denied", httpStatus: http.StatusForbidden, code: "insecure_denied", wantStatus: "insecure-denied"},
		{name: "engine disabled", httpStatus: http.StatusForbidden, code: "engine_disabled", wantStatus: "disabled"},
		{name: "unrelated policy error", httpStatus: http.StatusTooManyRequests, code: "rate_limited", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				insecureWriteErr(w, tc.httpStatus, tc.code, "gate response")
			})
			resp, err := c.AuthRetrieve(context.Background(), "abc")
			if tc.wantErr {
				var he *HTTPError
				if !errors.As(err, &he) || he.Code != tc.code {
					t.Fatalf("error = %T %v, want typed HTTPError code %q", err, err, tc.code)
				}
				if resp != nil {
					t.Fatalf("response = %#v, want nil alongside the error", resp)
				}
				return
			}
			if err != nil {
				t.Fatalf("retrieve: %v", err)
			}
			if resp.Status != tc.wantStatus {
				t.Fatalf("status = %q, want %q", resp.Status, tc.wantStatus)
			}
		})
	}
}

// TestAuthRetrieveEngineDisabledCarriesMessage pins the synthetic message the
// boot banner prints for a disabled engine — there is no server text to reuse.
func TestAuthRetrieveEngineDisabledCarriesMessage(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		insecureWriteErr(w, http.StatusForbidden, "engine_disabled", "claude disabled")
	})
	resp, err := c.AuthRetrieve(context.Background(), "")
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	if resp.Status != "disabled" || resp.Message != "engine disabled for this host" {
		t.Fatalf("response = %#v", resp)
	}
}

// TestAuthRetrieveSurfacesErrorStatusBody covers a 200 response whose envelope
// reports status=error: the decoded body is still returned so callers can read
// the reason, but the call fails.
func TestAuthRetrieveSurfacesErrorStatusBody(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "error", "message": "host unknown"})
	})
	resp, err := c.AuthRetrieve(context.Background(), "")
	if err == nil || !strings.Contains(err.Error(), "auth retrieve: host unknown") {
		t.Fatalf("error = %v, want auth retrieve wrap", err)
	}
	if resp == nil || resp.Status != "error" {
		t.Fatalf("response = %#v, want the decoded error body", resp)
	}
}

// TestAuthStoreAcceptListAndRejectionReason pins the accept-list — valid and
// updated unconditionally, outdated only when the server also returns the
// authoritative auth to apply — plus the message/action/default fallback chain
// the failure message uses.
func TestAuthStoreAcceptListAndRejectionReason(t *testing.T) {
	authoritative := map[string]any{
		"auth":                   map[string]any{"claudeAiOauth": map[string]any{"accessToken": "canonical"}},
		"canonical_digest":       strings.Repeat("a", 64),
		"canonical_last_refresh": "2026-01-02T00:00:00Z",
	}
	for _, tc := range []struct {
		name       string
		body       map[string]any
		wantErr    bool
		wantReason string
	}{
		{name: "valid", body: map[string]any{"status": "valid"}},
		{name: "updated", body: map[string]any{"status": "updated"}},
		{name: "uppercase updated", body: map[string]any{"status": " UPDATED "}},
		{
			name: "outdated with authoritative auth",
			body: map[string]any{"status": "outdated", "auth": authoritative["auth"],
				"canonical_digest": authoritative["canonical_digest"], "canonical_last_refresh": authoritative["canonical_last_refresh"]},
		},
		{
			name:       "outdated without canonical proof",
			body:       map[string]any{"status": "outdated", "message": "canonical newer"},
			wantErr:    true,
			wantReason: "status=outdated reason=canonical newer",
		},
		{
			name:       "message reason",
			body:       map[string]any{"status": "upload_required", "message": "candidate older than canonical", "action": "upload"},
			wantErr:    true,
			wantReason: "status=upload_required reason=candidate older than canonical",
		},
		{
			name:       "action reason fallback",
			body:       map[string]any{"status": "rejected", "action": "reauthenticate"},
			wantErr:    true,
			wantReason: "status=rejected reason=reauthenticate",
		},
		{
			name:       "default reason fallback",
			body:       map[string]any{"status": "unknown"},
			wantErr:    true,
			wantReason: "status=unknown reason=server did not accept uploaded auth",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var request map[string]any
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				request = decodeAuthRequest(t, r)
				_ = json.NewEncoder(w).Encode(tc.body)
			})
			resp, err := c.AuthStore(context.Background(), json.RawMessage(`{"last_refresh":"2026-01-01T00:00:00Z"}`))
			if request["command"] != "store" || request["engine"] != "claude" {
				t.Fatalf("request body = %#v", request)
			}
			if resp == nil {
				t.Fatal("response dropped; callers need it even on rejection")
			}
			if !tc.wantErr {
				if err != nil {
					t.Fatalf("store: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantReason) {
				t.Fatalf("error = %v, want reason %q", err, tc.wantReason)
			}
		})
	}
}

// TestAuthStoreErrorStatusUsesServerMessage covers the status=error branch,
// which reports the server's own message rather than the not-accepted wrap.
func TestAuthStoreErrorStatusUsesServerMessage(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "error", "message": "runner unreachable"})
	})
	resp, err := c.AuthStore(context.Background(), json.RawMessage(`{}`))
	if err == nil || err.Error() != "runner unreachable" {
		t.Fatalf("error = %v, want the raw server message", err)
	}
	if resp == nil || resp.Status != "error" {
		t.Fatalf("response = %#v", resp)
	}
}

// TestAuthCandidateRejectionClassifiers pins the deliberately narrow scope of
// both classifiers: only validation-shaped failures prove the candidate itself
// is bad, and only the rotated-writeback response invalidates the local token
// too.
func TestAuthCandidateRejectionClassifiers(t *testing.T) {
	for _, tc := range []struct {
		name             string
		err              error
		wantDefinitive   bool
		wantUnsafeRunner bool
	}{
		{name: "422 without code", err: &HTTPError{StatusCode: http.StatusUnprocessableEntity}, wantDefinitive: true},
		{name: "422 validation_failed", err: &HTTPError{StatusCode: http.StatusUnprocessableEntity, Code: "validation_failed"}, wantDefinitive: true},
		{name: "422 mixed case code", err: &HTTPError{StatusCode: http.StatusUnprocessableEntity, Code: " Validation_Failed "}, wantDefinitive: true},
		{name: "422 policy code", err: &HTTPError{StatusCode: http.StatusUnprocessableEntity, Code: "policy_denied"}},
		{name: "400 validation_failed", err: &HTTPError{StatusCode: http.StatusBadRequest, Code: "validation_failed"}, wantDefinitive: true},
		{name: "400 without code", err: &HTTPError{StatusCode: http.StatusBadRequest}},
		{name: "401 unauthorized", err: &HTTPError{StatusCode: http.StatusUnauthorized, Code: "unauthorized"}},
		{name: "403 policy", err: &HTTPError{StatusCode: http.StatusForbidden, Code: "engine_disabled"}},
		{name: "429 rate limited", err: &HTTPError{StatusCode: http.StatusTooManyRequests, Code: "rate_limited"}},
		{name: "503 rotated writeback", err: &HTTPError{StatusCode: http.StatusServiceUnavailable, Code: "runner_updated_auth_invalid"}, wantUnsafeRunner: true},
		{name: "503 ordinary outage", err: &HTTPError{StatusCode: http.StatusServiceUnavailable, Code: "runner_unreachable"}},
		{name: "plain error", err: errors.New("dial tcp: connection refused")},
		{name: "nil error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsDefinitiveAuthCandidateRejection(tc.err); got != tc.wantDefinitive {
				t.Fatalf("IsDefinitiveAuthCandidateRejection = %v, want %v", got, tc.wantDefinitive)
			}
			if got := IsUnsafeRunnerUpdatedAuthError(tc.err); got != tc.wantUnsafeRunner {
				t.Fatalf("IsUnsafeRunnerUpdatedAuthError = %v, want %v", got, tc.wantUnsafeRunner)
			}
		})
	}
}

// TestCheckAuthStatusNormalizesStatusAndReason pins what ui.PollApproval reads:
// a lower-cased status plus a single reason line taken from message, or action
// when the server sent no message.
func TestCheckAuthStatusNormalizesStatusAndReason(t *testing.T) {
	for _, tc := range []struct {
		name       string
		body       map[string]any
		wantStatus string
		wantReason string
	}{
		{
			name:       "message reason",
			body:       map[string]any{"status": " INSECURE ", "message": "awaiting approval", "action": "approve"},
			wantStatus: "insecure",
			wantReason: "awaiting approval",
		},
		{
			name:       "action reason fallback",
			body:       map[string]any{"status": "Insecure-Denied", "action": "operator denied host"},
			wantStatus: "insecure-denied",
			wantReason: "operator denied host",
		},
		{
			name:       "no reason at all",
			body:       map[string]any{"status": "VALID"},
			wantStatus: "valid",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(w).Encode(tc.body)
			})
			status, reason, err := c.CheckAuthStatus(context.Background())
			if err != nil {
				t.Fatalf("check: %v", err)
			}
			if status != tc.wantStatus || reason != tc.wantReason {
				t.Fatalf("CheckAuthStatus = (%q, %q), want (%q, %q)", status, reason, tc.wantStatus, tc.wantReason)
			}
		})
	}
}

// TestCheckAuthStatusPropagatesRetrieveError makes sure a failed retrieve is not
// reported to the poller as an empty status.
func TestCheckAuthStatusPropagatesRetrieveError(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		insecureWriteErr(w, http.StatusUnauthorized, "unauthorized", "bad key")
	})
	status, reason, err := c.CheckAuthStatus(context.Background())
	if err == nil {
		t.Fatal("expected the transport error to propagate")
	}
	if status != "" || reason != "" {
		t.Fatalf("CheckAuthStatus = (%q, %q), want empty on error", status, reason)
	}
}

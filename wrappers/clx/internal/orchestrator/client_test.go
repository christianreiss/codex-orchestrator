package orchestrator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c, err := New(Options{BaseURL: srv.URL, APIKey: "sk-claude-test"})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	return c
}

func TestAuthRetrieveSendsEngineClaude(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 256)
		n, _ := r.Body.Read(buf)
		if !strings.Contains(string(buf[:n]), `"engine":"claude"`) {
			t.Errorf("expected engine=claude in body: %s", buf[:n])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "current"})
	})
	if _, err := c.AuthRetrieve(context.Background(), ""); err != nil {
		t.Fatalf("retrieve: %v", err)
	}
}

func TestAuthStoreReturnsServerAuthResponse(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"command":"store"`) || !strings.Contains(string(body), `"engine":"claude"`) {
			t.Fatalf("unexpected body: %s", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":             "updated",
			"canonical_digest":   strings.Repeat("a", 64),
			"runner_applied":     true,
			"auth":               map[string]any{"claudeAiOauth": map[string]any{"accessToken": "new"}},
			"verification_state": "verified",
		})
	})
	resp, err := c.AuthStore(context.Background(), json.RawMessage(`{"last_refresh":"2026-01-01T00:00:00Z"}`))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if resp == nil || resp.Status != "updated" || !resp.RunnerApplied || len(resp.Auth) == 0 {
		t.Fatalf("unexpected response: %#v", resp)
	}
}

func TestAuthStoreAcceptsOutdatedAuthoritativeResponse(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":                 "outdated",
			"action":                 "store",
			"canonical_digest":       strings.Repeat("b", 64),
			"canonical_last_refresh": "2026-01-02T00:00:00Z",
			"auth":                   map[string]any{"claudeAiOauth": map[string]any{"accessToken": "newer-canonical"}},
		})
	})
	resp, err := c.AuthStore(context.Background(), json.RawMessage(`{"last_refresh":"2026-01-01T00:00:00Z"}`))
	if err != nil {
		t.Fatalf("authoritative arbitration response rejected: %v", err)
	}
	if resp == nil || resp.Status != "outdated" {
		t.Fatalf("expected authoritative response, got %#v", resp)
	}
}

func TestAuthStoreRejectsOutdatedWithoutAuthoritativeAuth(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "outdated", "action": "store"})
	})
	resp, err := c.AuthStore(context.Background(), json.RawMessage(`{"last_refresh":"2026-01-01T00:00:00Z"}`))
	if err == nil || resp == nil || resp.Status != "outdated" || !strings.Contains(err.Error(), "status=outdated") {
		t.Fatalf("missing authoritative auth was accepted: resp=%#v err=%v", resp, err)
	}
}

func TestAuthStoreRejectsLegacyFallbackOutdatedWithoutCanonicalProof(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":  "outdated",
			"message": "runner verification failed",
			"auth":    map[string]any{"claudeAiOauth": map[string]any{"accessToken": "old"}},
		})
	})
	resp, err := c.AuthStore(context.Background(), json.RawMessage(`{"last_refresh":"2026-01-01T00:00:00Z"}`))
	if err == nil || resp == nil || resp.Status != "outdated" {
		t.Fatalf("legacy fallback was accepted: resp=%#v err=%v", resp, err)
	}
}

func TestAuthCandidateAcceptedDistinguishesStoreArbitration(t *testing.T) {
	for _, tc := range []struct {
		name string
		resp *AuthRetrieveResponse
		want bool
	}{
		{name: "valid verified", resp: &AuthRetrieveResponse{Status: "valid", VerificationState: "verified"}, want: true},
		{name: "updated verified", resp: &AuthRetrieveResponse{Status: "updated", VerificationState: "verified"}, want: true},
		{name: "outdated canonical won", resp: &AuthRetrieveResponse{Status: "outdated"}},
		{name: "failed verification", resp: &AuthRetrieveResponse{Status: "valid", VerificationState: "failed"}},
		{name: "pending verification", resp: &AuthRetrieveResponse{Status: "valid", VerificationState: "pending"}},
		{name: "unknown verification", resp: &AuthRetrieveResponse{Status: "valid", VerificationState: "unknown"}},
		{name: "empty verification", resp: &AuthRetrieveResponse{Status: "valid"}},
		{name: "definitive rejection", resp: &AuthRetrieveResponse{Status: "valid", CandidateRejectedDefinitive: true}},
		{name: "credential rejection", resp: &AuthRetrieveResponse{Status: "valid", VerificationState: "verified", CandidateCredentialRejected: true}},
		{name: "nil", resp: nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.resp.AuthCandidateAccepted(); got != tc.want {
				t.Fatalf("AuthCandidateAccepted()=%v want=%v", got, tc.want)
			}
		})
	}
}

func TestRetrieveAgents(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","data":{"status":"updated","content":"# CLAUDE.md\n"}}`))
	})
	body, err := c.RetrieveAgents(context.Background(), "")
	if err != nil {
		t.Fatalf("agents: %v", err)
	}
	if string(body) != "# CLAUDE.md\n" {
		t.Fatalf("body = %q", string(body))
	}
}

func TestRetrieveConfigUnwrapsContentAndSendsSha(t *testing.T) {
	var requestBody string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requestBody = string(body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok",
			"data": map[string]any{
				"status":  "updated",
				"content": `{"model":"claude-sonnet-4-6"}` + "\n",
			},
		})
	})
	body, err := c.RetrieveConfig(context.Background(), "abc")
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	if string(body) != `{"model":"claude-sonnet-4-6"}`+"\n" {
		t.Fatalf("body = %q", string(body))
	}
	if !strings.Contains(requestBody, `"sha256":"abc"`) {
		t.Fatalf("missing sha256 in request: %s", requestBody)
	}
	if strings.Contains(requestBody, `"digest"`) {
		t.Fatalf("request still used digest: %s", requestBody)
	}
}

// insecureWriteErr writes a standard error envelope with the given HTTP status
// and machine code, matching the orchestrator's insecure-approval responses.
func insecureWriteErr(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":  "error",
		"message": message,
		"code":    code,
	})
}

func TestAuthRetrievePendingMapsToInsecure(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		insecureWriteErr(w, http.StatusLocked, "insecure_pending", "Insecure host approval pending")
	})
	resp, err := c.AuthRetrieve(context.Background(), "")
	if err != nil {
		t.Fatalf("expected no error for insecure_pending, got %v", err)
	}
	if resp.Status != "insecure" {
		t.Fatalf("status = %q, want insecure", resp.Status)
	}
}

func TestAuthRetrieveDeniedMapsToInsecureDenied(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		insecureWriteErr(w, http.StatusForbidden, "insecure_denied", "Insecure host approval denied")
	})
	resp, err := c.AuthRetrieve(context.Background(), "")
	if err != nil {
		t.Fatalf("expected no error for insecure_denied, got %v", err)
	}
	if resp.Status != "insecure-denied" {
		t.Fatalf("status = %q, want insecure-denied", resp.Status)
	}
}

func TestAuthRetrieveOtherErrorsStillError(t *testing.T) {
	// A genuine forbidden (kill switch etc.) without the insecure code must NOT
	// be swallowed into an insecure status — the caller still treats it as an error.
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		insecureWriteErr(w, http.StatusForbidden, "api_disabled", "API disabled")
	})
	if _, err := c.AuthRetrieve(context.Background(), ""); err == nil {
		t.Fatal("expected error for non-insecure 403, got nil")
	}
}

func TestInsecureStatusFromError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"pending", &HTTPError{StatusCode: http.StatusLocked, Code: "insecure_pending"}, "insecure"},
		{"denied", &HTTPError{StatusCode: http.StatusForbidden, Code: "insecure_denied"}, "insecure-denied"},
		{"locked-other-code", &HTTPError{StatusCode: http.StatusLocked, Code: "other"}, ""},
		{"forbidden-other-code", &HTTPError{StatusCode: http.StatusForbidden, Code: "forbidden"}, ""},
		{"not-http-error", io.EOF, ""},
		{"nil", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := InsecureStatusFromError(tc.err); got != tc.want {
				t.Fatalf("InsecureStatusFromError = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseErrorCodeAcceptsSupportedEnvelopes(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "standard top-level code",
			body: `{"status":"error","message":"pending","code":"insecure_pending"}`,
			want: "insecure_pending",
		},
		{
			name: "openai nested code",
			body: `{"error":{"message":"pending","type":"locked_error","code":"insecure_pending"}}`,
			want: "insecure_pending",
		},
		{
			name: "anthropic nested code",
			body: `{"type":"error","error":{"type":"locked_error","message":"pending","code":"insecure_pending"}}`,
			want: "insecure_pending",
		},
		{name: "missing code", body: `{"status":"error","message":"pending"}`, want: ""},
		{name: "invalid json", body: `{`, want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseErrorCode([]byte(tc.body)); got != tc.want {
				t.Fatalf("parseErrorCode = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestAuthCandidateErrorClassifiersAreNarrow(t *testing.T) {
	for _, tc := range []struct {
		name             string
		err              error
		wantDefinitive   bool
		wantUnsafeRunner bool
	}{
		{name: "422 validation", err: &HTTPError{StatusCode: 422, Code: "validation_failed"}, wantDefinitive: true},
		{name: "legacy 422 without code", err: &HTTPError{StatusCode: 422}, wantDefinitive: true},
		{name: "400 validation", err: &HTTPError{StatusCode: 400, Code: "validation_failed"}, wantDefinitive: true},
		{name: "400 generic", err: &HTTPError{StatusCode: 400, Code: "bad_request"}},
		{name: "422 policy code", err: &HTTPError{StatusCode: 422, Code: "policy_denied"}},
		{name: "403 engine policy", err: &HTTPError{StatusCode: 403, Code: "engine_disabled"}},
		{name: "423 approval", err: &HTTPError{StatusCode: 423, Code: "insecure_pending"}},
		{name: "429 rate limit", err: &HTTPError{StatusCode: 429, Code: "rate_limited"}},
		{name: "ordinary runner outage", err: &HTTPError{StatusCode: 503, Code: "runner_unreachable"}},
		{name: "rotated unusable writeback", err: &HTTPError{StatusCode: 503, Code: "runner_updated_auth_invalid"}, wantUnsafeRunner: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsDefinitiveAuthCandidateRejection(tc.err); got != tc.wantDefinitive {
				t.Fatalf("definitive=%v want=%v", got, tc.wantDefinitive)
			}
			if got := IsUnsafeRunnerUpdatedAuthError(tc.err); got != tc.wantUnsafeRunner {
				t.Fatalf("unsafe runner=%v want=%v", got, tc.wantUnsafeRunner)
			}
		})
	}
}

func TestAuthStorePreservesTypedUnsafe503CodeAfterRetries(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"status":"error","code":"runner_updated_auth_invalid","message":"bad rotated writeback"}`))
	})
	_, err := c.AuthStore(context.Background(), json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z"}`))
	if !IsUnsafeRunnerUpdatedAuthError(err) {
		t.Fatalf("AuthStore lost typed unsafe 503: %T %v", err, err)
	}
}

func TestAuthResponseHostSecurity(t *testing.T) {
	for _, tc := range []struct {
		name       string
		resp       *AuthRetrieveResponse
		wantSecure bool
		wantKnown  bool
	}{
		{name: "secure host object", resp: &AuthRetrieveResponse{Host: &HostInfo{Secure: true}}, wantSecure: true, wantKnown: true},
		{name: "insecure host object", resp: &AuthRetrieveResponse{Host: &HostInfo{Secure: false}}, wantKnown: true},
		{name: "insecure status", resp: &AuthRetrieveResponse{Status: "insecure"}, wantKnown: true},
		{name: "unknown compact response", resp: &AuthRetrieveResponse{Status: "valid"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			secure, known := tc.resp.HostSecurity()
			if secure != tc.wantSecure || known != tc.wantKnown {
				t.Fatalf("HostSecurity=(%v,%v) want=(%v,%v)", secure, known, tc.wantSecure, tc.wantKnown)
			}
		})
	}
}

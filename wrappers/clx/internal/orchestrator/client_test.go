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

func TestAuthStoreRejectsFallbackRetrieveResponse(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":  "outdated",
			"action":  "store",
			"message": "runner verification failed",
			"auth":    map[string]any{"claudeAiOauth": map[string]any{"accessToken": "old"}},
		})
	})
	resp, err := c.AuthStore(context.Background(), json.RawMessage(`{"last_refresh":"2026-01-01T00:00:00Z"}`))
	if err == nil {
		t.Fatalf("expected store rejection, got resp=%#v", resp)
	}
	if resp == nil || resp.Status != "outdated" {
		t.Fatalf("expected fallback response to be returned, got %#v", resp)
	}
	if !strings.Contains(err.Error(), "status=outdated") {
		t.Fatalf("unexpected error: %v", err)
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

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
	c, err := New(Options{BaseURL: srv.URL, APIKey: "sk-codex-test"})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	return c
}

func TestAuthRetrieveSendsDigestAndAPIKey(t *testing.T) {
	var sawKey string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		sawKey = r.Header.Get("X-API-Key")
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"digest":"abc"`) {
			t.Errorf("missing digest: %s", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "current"})
	})
	resp, err := c.AuthRetrieve(context.Background(), "abc")
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	if resp.Status != "current" {
		t.Errorf("status: %s", resp.Status)
	}
	if sawKey != "sk-codex-test" {
		t.Errorf("api key not forwarded: %q", sawKey)
	}
}

func TestPostUsage(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/usage" {
			t.Errorf("path: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	err := c.PostUsage(context.Background(), UsageRecord{Engine: "codex", InputTokens: 100, OutputTokens: 50})
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
}

func TestGetLaneRoundTrip(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","data":{"lane":"spark"}}`))
	})
	lane, err := c.GetLane(context.Background())
	if err != nil {
		t.Fatalf("lane: %v", err)
	}
	if lane != "spark" {
		t.Errorf("lane: %s", lane)
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
				"sha256":  "def",
				"content": "model = \"gpt-5.4\"\n",
			},
		})
	})
	body, err := c.RetrieveConfig(context.Background(), "abc")
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	if string(body) != "model = \"gpt-5.4\"\n" {
		t.Fatalf("body = %q", string(body))
	}
	if !strings.Contains(requestBody, `"sha256":"abc"`) {
		t.Fatalf("missing sha256 in request: %s", requestBody)
	}
	if strings.Contains(requestBody, `"digest"`) {
		t.Fatalf("request still used digest: %s", requestBody)
	}
}

func TestRetrieveAgentsUnwrapsContent(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok",
			"data": map[string]any{
				"status":  "updated",
				"content": "# AGENTS.md\n",
			},
		})
	})
	body, err := c.RetrieveAgents(context.Background(), "")
	if err != nil {
		t.Fatalf("agents: %v", err)
	}
	if string(body) != "# AGENTS.md\n" {
		t.Fatalf("body = %q", string(body))
	}
}

func TestPostUsagesArrayShape(t *testing.T) {
	var gotBody string
	var gotPath string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	batch := UsagesBatch{
		Engine: "codex",
		FQDN:   "h.example.com",
		Usages: []UsageEntry{
			{Model: "gpt-5.4", Total: 100, Input: 70, Output: 30, Line: "Token usage: total=100 input=70 output=30"},
		},
	}
	if err := c.PostUsages(context.Background(), batch); err != nil {
		t.Fatalf("post usages: %v", err)
	}
	if gotPath != "/usage" {
		t.Errorf("path = %q want /usage", gotPath)
	}
	for _, want := range []string{
		`"engine":"codex"`,
		`"fqdn":"h.example.com"`,
		`"usages":[`,
		`"total":100`,
		`"input":70`,
		`"output":30`,
		`"line":"Token usage: total=100 input=70 output=30"`,
	} {
		if !strings.Contains(gotBody, want) {
			t.Errorf("body missing %q\nbody=%s", want, gotBody)
		}
	}
	// Zero counters must be omitted to match legacy bash payload semantics.
	if strings.Contains(gotBody, `"cached":0`) || strings.Contains(gotBody, `"reasoning":0`) {
		t.Errorf("zero counters should be omitted, body=%s", gotBody)
	}
}

func TestPostUsagesDefaultsEngine(t *testing.T) {
	var gotBody string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	if err := c.PostUsages(context.Background(), UsagesBatch{Usages: []UsageEntry{{Total: 1}}}); err != nil {
		t.Fatalf("post: %v", err)
	}
	if !strings.Contains(gotBody, `"engine":"codex"`) {
		t.Errorf("engine default missing: %s", gotBody)
	}
}

func TestRetryOn5xx(t *testing.T) {
	attempts := 0
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts < 2 {
			w.WriteHeader(503)
			return
		}
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	// PostUsage passes retries=1, so total attempts is 2.
	err := c.PostUsage(context.Background(), UsageRecord{Engine: "codex"})
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if attempts != 2 {
		t.Errorf("attempts: %d (want 2)", attempts)
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

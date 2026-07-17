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

func TestAuthStoreReturnsAuthoritativeOutdatedResponse(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":  "outdated",
			"action":  "store",
			"message": "runner verification failed",
			"auth":    map[string]any{"tokens": map[string]any{"access_token": "old"}},
		})
	})
	resp, err := c.AuthStore(context.Background(), json.RawMessage(`{"last_refresh":"2026-01-01T00:00:00Z"}`))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if resp == nil || resp.Status != "outdated" || !strings.Contains(string(resp.Auth), "access_token") {
		t.Fatalf("response = %+v", resp)
	}
}

func TestAuthStoreRejectsNonSuccessStatus(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "upload_required", "message": "not stored"})
	})
	_, err := c.AuthStore(context.Background(), json.RawMessage(`{"last_refresh":"2026-01-01T00:00:00Z"}`))
	if err == nil || !strings.Contains(err.Error(), "status=upload_required") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestAuthStorePreservesTypedFinalServerError(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"code":"runner_updated_auth_invalid","message":"rotated writeback unusable"}`))
	})
	_, err := c.AuthStore(context.Background(), json.RawMessage(`{"last_refresh":"2026-01-01T00:00:00Z"}`))
	if !IsUnsafeRunnerUpdatedAuthError(err) {
		t.Fatalf("AuthStore error lost typed 503 code: %T %v", err, err)
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
		{name: "403 engine policy", err: &HTTPError{StatusCode: 403, Code: "engine_disabled"}},
		{name: "423 approval", err: &HTTPError{StatusCode: 423, Code: "insecure_pending"}},
		{name: "429 rate limit", err: &HTTPError{StatusCode: 429, Code: "rate_limited"}},
		{name: "ordinary runner outage", err: &HTTPError{StatusCode: 503, Code: "runner_unreachable"}},
		{name: "rotated unusable writeback", err: &HTTPError{StatusCode: 503, Code: "runner_updated_auth_invalid"}, wantUnsafeRunner: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsDefinitiveAuthCandidateRejection(tc.err); got != tc.wantDefinitive {
				t.Fatalf("definitive = %v, want %v", got, tc.wantDefinitive)
			}
			if got := IsUnsafeRunnerUpdatedAuthError(tc.err); got != tc.wantUnsafeRunner {
				t.Fatalf("unsafe runner = %v, want %v", got, tc.wantUnsafeRunner)
			}
		})
	}
}

// TestGetLaneRoundTrip pins GetLane to the *real* GET /host/lane contract, in
// which the orchestrator returns {lane_preference, effective_lane} both at the
// root and under `data`. The earlier fixture asserted a `data.lane` field the
// server never emits, so the test was green while `cdx lane` printed an empty
// lane against the live server.
func TestGetLaneRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "standard envelope with root + data copies",
			body: `{"status":"ok","data":{"lane_preference":"spark","effective_lane":"spark","host_id":1,"fqdn":"h"},"lane_preference":"spark","effective_lane":"spark","host_id":1,"fqdn":"h"}`,
			want: "spark",
		},
		{
			name: "data-only envelope (legacy bash shape)",
			body: `{"status":"ok","data":{"lane_preference":null,"effective_lane":"normal"}}`,
			want: "normal",
		},
		{
			name: "no preference set defaults to normal",
			body: `{"status":"ok","data":{"lane_preference":null,"effective_lane":""}}`,
			want: "normal",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(tc.body))
			})
			lane, err := c.GetLane(context.Background())
			if err != nil {
				t.Fatalf("lane: %v", err)
			}
			if lane != tc.want {
				t.Errorf("lane = %q, want %q", lane, tc.want)
			}
		})
	}
}

// TestListSkillsRealShape pins ListSkills to the real GET /skills?engine=codex
// contract: the handler returns {engine, skills:[…]} which the envelope exposes
// at both the root and under `data`. The skill array therefore lives at
// `skills`/`data.skills`, never at `data` (which is an object). The earlier
// struct decoded `data` straight into a []Skill, so every list call errored and
// the boot-screen "skills" dot never updated.
func TestListSkillsRealShape(t *testing.T) {
	var sawPath string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.RequestURI()
		_, _ = w.Write([]byte(`{"status":"ok",` +
			`"data":{"engine":"codex","skills":[` +
			`{"slug":"coco","sha256":"aaa","display_name":"Coco","managed":true},` +
			`{"slug":"deploy","sha256":"bbb","display_name":"Deploy"}]},` +
			`"engine":"codex",` +
			`"skills":[` +
			`{"slug":"coco","sha256":"aaa","display_name":"Coco","managed":true},` +
			`{"slug":"deploy","sha256":"bbb","display_name":"Deploy"}]}`))
	})
	list, err := c.ListSkills(context.Background())
	if err != nil {
		t.Fatalf("list skills: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("got %d skills, want 2: %+v", len(list), list)
	}
	if list[0].Slug != "coco" || list[0].SHA256 != "aaa" || list[0].DisplayName != "Coco" {
		t.Fatalf("unexpected first skill: %+v", list[0])
	}
	if sawPath != "/skills?engine=codex" {
		t.Fatalf("request path = %q, want /skills?engine=codex", sawPath)
	}
}

// TestListSkillsDataOnlyEnvelope covers a server build that emits only the
// `data`-nested copy (no root duplication), so the fallback path is exercised.
func TestListSkillsDataOnlyEnvelope(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","data":{"engine":"codex","skills":[{"slug":"only","sha256":"ccc"}]}}`))
	})
	list, err := c.ListSkills(context.Background())
	if err != nil {
		t.Fatalf("list skills: %v", err)
	}
	if len(list) != 1 || list[0].Slug != "only" || list[0].SHA256 != "ccc" {
		t.Fatalf("unexpected skills: %+v", list)
	}
}

// TestChatGPTQuotaSparkWindowBackfill pins the spark-lane quota decode to the
// real crane shape: the spark limit/reset values live ONLY under
// chatgpt.spark_window.{primary,secondary}_window, never as flat
// spark_primary_limit_seconds root keys. Without the backfill the spark quota
// bars render a percent but no reset countdown / projection.
func TestChatGPTQuotaSparkWindowBackfill(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"valid","chatgpt":{` +
			`"status":"active",` +
			`"rate_allowed":false,"rate_limit_reached":true,` +
			`"primary_used_percent":2,"primary_limit_seconds":18000,"primary_reset_after_seconds":11520,` +
			`"secondary_used_percent":5,"secondary_limit_seconds":604800,"secondary_reset_after_seconds":169200,` +
			`"spark_rate_allowed":true,"spark_rate_limit_reached":false,"spark_primary_used_percent":42,` +
			`"spark_secondary_used_percent":7,` +
			`"spark_window":{` +
			`"primary_window":{"used_percent":42,"limit_seconds":18000,"reset_after_seconds":3600,"reset_at":null},` +
			`"secondary_window":{"used_percent":7,"limit_seconds":604800,"reset_after_seconds":123456}` +
			`}}}`))
	})
	resp, err := c.AuthRetrieve(context.Background(), "")
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	q := resp.ChatGPT
	if q == nil {
		t.Fatal("nil chatgpt quota")
	}
	// Normal-lane fields (flat at root) must still decode through the custom
	// UnmarshalJSON — they drive the live boot-screen quota bars + projection.
	if q.PrimaryUsed == nil || *q.PrimaryUsed != 2 {
		t.Fatalf("normal primary used = %v, want 2", q.PrimaryUsed)
	}
	if q.PrimaryResetAfter == nil || *q.PrimaryResetAfter != 11520 {
		t.Fatalf("normal primary reset_after = %v, want 11520", q.PrimaryResetAfter)
	}
	if q.SecondaryUsed == nil || *q.SecondaryUsed != 5 {
		t.Fatalf("normal secondary used = %v, want 5", q.SecondaryUsed)
	}
	if q.RateAllowed == nil || *q.RateAllowed || q.RateLimitReached == nil || !*q.RateLimitReached {
		t.Fatalf("normal provider flags = allowed=%v reached=%v", q.RateAllowed, q.RateLimitReached)
	}
	if q.SparkRateAllowed == nil || !*q.SparkRateAllowed || q.SparkRateLimitReached == nil || *q.SparkRateLimitReached {
		t.Fatalf("spark provider flags = allowed=%v reached=%v", q.SparkRateAllowed, q.SparkRateLimitReached)
	}
	if q.SparkPrimaryLimitSec == nil || *q.SparkPrimaryLimitSec != 18000 {
		t.Fatalf("spark primary limit = %v, want 18000", q.SparkPrimaryLimitSec)
	}
	if q.SparkPrimaryResetAfter == nil || *q.SparkPrimaryResetAfter != 3600 {
		t.Fatalf("spark primary reset_after = %v, want 3600", q.SparkPrimaryResetAfter)
	}
	if q.SparkSecondaryLimitSec == nil || *q.SparkSecondaryLimitSec != 604800 {
		t.Fatalf("spark secondary limit = %v, want 604800", q.SparkSecondaryLimitSec)
	}
	if q.SparkSecondaryResetAfter == nil || *q.SparkSecondaryResetAfter != 123456 {
		t.Fatalf("spark secondary reset_after = %v, want 123456", q.SparkSecondaryResetAfter)
	}
	// Used percent is present at root AND in the window; both agree.
	if q.SparkPrimaryUsed == nil || *q.SparkPrimaryUsed != 42 {
		t.Fatalf("spark primary used = %v, want 42", q.SparkPrimaryUsed)
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
	// SetLane passes retries=1, so total attempts is 2.
	err := c.SetLane(context.Background(), "spark")
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

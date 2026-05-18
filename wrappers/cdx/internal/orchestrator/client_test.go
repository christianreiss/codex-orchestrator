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

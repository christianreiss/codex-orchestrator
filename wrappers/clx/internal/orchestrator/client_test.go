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
		Engine: "claude",
		FQDN:   "h.example.com",
		Usages: []UsageEntry{
			{Model: "claude-sonnet-4-6", Total: 150, Input: 100, Output: 50, Cached: 10, CacheCreation: 5, Line: "Token usage: total=150 input=100 (+ 15 cached) output=50"},
		},
	}
	if err := c.PostUsages(context.Background(), batch); err != nil {
		t.Fatalf("post usages: %v", err)
	}
	if gotPath != "/usage" {
		t.Errorf("path = %q want /usage", gotPath)
	}
	for _, want := range []string{
		`"engine":"claude"`,
		`"fqdn":"h.example.com"`,
		`"usages":[`,
		`"total":150`,
		`"input":100`,
		`"output":50`,
		`"cached":10`,
		`"cache_creation":5`,
	} {
		if !strings.Contains(gotBody, want) {
			t.Errorf("body missing %q\nbody=%s", want, gotBody)
		}
	}
	// reasoning field doesn't exist on the Claude shape — must NOT appear.
	if strings.Contains(gotBody, `"reasoning"`) {
		t.Errorf("body should not include reasoning for claude: %s", gotBody)
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
	if !strings.Contains(gotBody, `"engine":"claude"`) {
		t.Errorf("engine default missing: %s", gotBody)
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

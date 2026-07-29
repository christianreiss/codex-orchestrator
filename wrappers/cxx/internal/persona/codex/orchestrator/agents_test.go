package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
)

// captureAgentsRequest runs one RetrieveAgents call against a stub server and
// returns the method, path and decoded JSON body it posted.
func captureAgentsRequest(t *testing.T, digest string) (method, path string, body map[string]any) {
	t.Helper()
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("decode request body %q: %v", raw, err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok",
			"data":   map[string]any{"status": "updated", "content": "# AGENTS.md\n"},
		})
	})
	if _, err := c.RetrieveAgents(context.Background(), digest); err != nil {
		t.Fatalf("retrieve agents: %v", err)
	}
	return method, path, body
}

// TestRetrieveAgentsPostsCodexScopedRequest pins the engine literal that picks
// the document: this binary is the Codex wrapper, so a copied "claude" would
// hand every cdx host the CLAUDE.md body under the AGENTS.md filename.
func TestRetrieveAgentsPostsCodexScopedRequest(t *testing.T) {
	method, path, body := captureAgentsRequest(t, "abc123")
	if method != http.MethodPost || path != "/agents/retrieve" {
		t.Fatalf("request = %s %s, want POST /agents/retrieve", method, path)
	}
	if body["engine"] != "codex" {
		t.Fatalf("engine = %v, want codex", body["engine"])
	}
	if body["sha256"] != "abc123" {
		t.Fatalf("sha256 = %v, want abc123", body["sha256"])
	}
}

// TestRetrieveAgentsOmitsEmptyDigest keeps the key absent rather than empty: the
// server reads a present sha256 as "the host already holds this revision", so an
// empty one would let it answer unchanged and starve a host with no AGENTS.md.
func TestRetrieveAgentsOmitsEmptyDigest(t *testing.T) {
	_, _, body := captureAgentsRequest(t, "")
	if _, ok := body["sha256"]; ok {
		t.Fatalf("sha256 sent for an empty digest: %v", body)
	}
	if body["engine"] != "codex" {
		t.Fatalf("engine = %v, want codex", body["engine"])
	}
}

// TestRetrieveAgentsSendsNoHostHints separates this route from /config/retrieve:
// home/username only exist there to bake the per-user trust stanza, and AGENTS.md
// renders the same for every host.
func TestRetrieveAgentsSendsNoHostHints(t *testing.T) {
	_, _, body := captureAgentsRequest(t, "abc123")
	for _, key := range []string{"home", "username"} {
		if _, ok := body[key]; ok {
			t.Fatalf("agents request carried %q: %v", key, body)
		}
	}
}

func TestRetrieveAgentsPropagatesHTTPError(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"status":"error","code":"engine_disabled","message":"engine disabled"}`))
	})
	body, err := c.RetrieveAgents(context.Background(), "abc123")
	if err == nil {
		t.Fatalf("expected error, got body %q", body)
	}
	if body != nil {
		t.Fatalf("body returned alongside error: %q", body)
	}
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusForbidden || httpErr.Code != "engine_disabled" {
		t.Fatalf("unexpected error: %T %v", err, err)
	}
}

package orchestrator

import (
	"context"
	"encoding/json"
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
		_, _ = w.Write([]byte(`{"status":"ok","data":"# CLAUDE.md\n"}`))
	})
	body, err := c.RetrieveAgents(context.Background(), "")
	if err != nil {
		t.Fatalf("agents: %v", err)
	}
	if len(body) == 0 {
		t.Fatal("expected body")
	}
}

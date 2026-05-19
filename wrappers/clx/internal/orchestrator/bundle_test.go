package orchestrator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestSyncBootstrap_TypedRoundTrip(t *testing.T) {
	var sawBody string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sync/bootstrap" {
			t.Errorf("path: %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		sawBody = string(body)
		_, _ = w.Write([]byte(`{
			"status":"ok",
			"auth":{"status":"valid"},
			"host":{"fqdn":"alpha.example","secure":true}
		}`))
	})
	resp, err := c.SyncBootstrap(context.Background(), BundleRequest{
		Engine:      "claude",
		IncludeAuth: true,
		AuthDigest:  "deadbeef",
	})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if resp.Auth == nil || resp.Auth.Status != "valid" {
		t.Errorf("auth: %+v", resp.Auth)
	}
	if !strings.Contains(sawBody, `"engine":"claude"`) {
		t.Errorf("engine missing: %s", sawBody)
	}
}

func TestSyncBootstrap_404(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
	})
	_, err := c.SyncBootstrap(context.Background(), BundleRequest{Engine: "claude"})
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("want 404 err, got %v", err)
	}
}

func TestSyncBootstrap_EngineDefault(t *testing.T) {
	var got BundleRequest
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	_, err := c.SyncBootstrap(context.Background(), BundleRequest{})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if got.Engine != "claude" {
		t.Errorf("default engine: %q", got.Engine)
	}
}

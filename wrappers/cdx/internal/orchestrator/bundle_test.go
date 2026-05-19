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
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"status":"ok",
			"auth":{"status":"valid","versions":{"client_version":"1.2.3"}},
			"agents":"# AGENTS.md\n",
			"config":"model=\"gpt-5.4\"\n",
			"host":{"fqdn":"alpha.example","secure":true}
		}`))
	})
	resp, err := c.SyncBootstrap(context.Background(), BundleRequest{
		Engine:      "codex",
		IncludeAuth: true,
		AuthDigest:  "deadbeef",
		Agents:      "a1",
		Config:      "c2",
		Home:        "/home/me",
		Username:    "me",
	})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if resp.Status != "ok" {
		t.Errorf("status: %s", resp.Status)
	}
	if resp.Auth == nil || resp.Auth.Status != "valid" {
		t.Errorf("auth: %+v", resp.Auth)
	}
	if resp.Host == nil || resp.Host.FQDN != "alpha.example" {
		t.Errorf("host: %+v", resp.Host)
	}
	if string(resp.Agents) != "# AGENTS.md\n" {
		t.Errorf("agents: %q", string(resp.Agents))
	}
	if string(resp.Config) != "model=\"gpt-5.4\"\n" {
		t.Errorf("config: %q", string(resp.Config))
	}
	for _, want := range []string{`"engine":"codex"`, `"include_auth":true`, `"auth_digest":"deadbeef"`, `"agents":"a1"`, `"home":"/home/me"`, `"username":"me"`} {
		if !strings.Contains(sawBody, want) {
			t.Errorf("body missing %s; body=%s", want, sawBody)
		}
	}
}

func TestSyncBootstrap_UnwrapsResourceObjects(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"status":"ok",
			"agents":{"status":"updated","version_id":1,"content":"# AGENTS.md\n"},
			"config":{"status":"updated","version_id":2,"content":"model = \"gpt-5.5\"\n"}
		}`))
	})
	resp, err := c.SyncBootstrap(context.Background(), BundleRequest{Engine: "codex"})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if string(resp.Agents) != "# AGENTS.md\n" {
		t.Errorf("agents: %q", string(resp.Agents))
	}
	if string(resp.Config) != "model = \"gpt-5.5\"\n" {
		t.Errorf("config: %q", string(resp.Config))
	}
}

func TestSyncBootstrap_404SurfacesAsError(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`not found`))
	})
	_, err := c.SyncBootstrap(context.Background(), BundleRequest{Engine: "codex"})
	if err == nil {
		t.Fatalf("expected error on 404")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Errorf("err should mention 404: %v", err)
	}
}

func TestSyncBootstrap_DefaultsEngine(t *testing.T) {
	var got BundleRequest
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	_, err := c.SyncBootstrap(context.Background(), BundleRequest{})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if got.Engine != "codex" {
		t.Errorf("engine default: %q", got.Engine)
	}
}

func TestSyncBootstrap_AuthCandidatePassedThrough(t *testing.T) {
	var sawBody string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sawBody = string(body)
		_, _ = w.Write([]byte(`{"status":"ok","auth":{"status":"valid"}}`))
	})
	cand := json.RawMessage(`{"last_refresh":"2026-05-01T00:00:00Z"}`)
	_, err := c.SyncBootstrap(context.Background(), BundleRequest{
		Engine:        "codex",
		IncludeAuth:   true,
		AuthCandidate: cand,
	})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if !strings.Contains(sawBody, `"auth_candidate":{"last_refresh":"2026-05-01T00:00:00Z"}`) {
		t.Errorf("auth_candidate not in body: %s", sawBody)
	}
}

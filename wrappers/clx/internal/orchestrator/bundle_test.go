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

func TestSyncBootstrap_UnwrapsResourceObjects(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"status":"ok",
			"agents":{"status":"updated","version_id":1,"content":"# CLAUDE.md\n"},
			"config":{"status":"updated","version_id":2,"content":"{\n  \"model\": \"sonnet\"\n}\n"}
		}`))
	})
	resp, err := c.SyncBootstrap(context.Background(), BundleRequest{Engine: "claude"})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if string(resp.Agents) != "# CLAUDE.md\n" {
		t.Errorf("agents: %q", string(resp.Agents))
	}
	if string(resp.Config) != "{\n  \"model\": \"sonnet\"\n}\n" {
		t.Errorf("config: %q", string(resp.Config))
	}
}

func TestSyncBootstrap_DecodesClaudeArtifactsAndSendsDigests(t *testing.T) {
	var got BundleRequest
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{
			"status":"ok",
			"claude_artifacts":{
				"subagent":[{"slug":"reviewer","sha256":"abc","status":"updated","content":"---\nname: reviewer\n---\n\nhi\n"}],
				"command":[{"slug":"deploy","sha256":"def","status":"unchanged"}],
				"output-style":[]
			}
		}`))
	})
	resp, err := c.SyncBootstrap(context.Background(), BundleRequest{
		Engine:    "claude",
		Artifacts: map[string]map[string]string{"subagent": {"reviewer": "old"}},
	})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if resp.ClaudeArtifacts == nil {
		t.Fatal("claude_artifacts not decoded")
	}
	if len(resp.ClaudeArtifacts.Subagents) != 1 || resp.ClaudeArtifacts.Subagents[0].Slug != "reviewer" {
		t.Errorf("subagents: %+v", resp.ClaudeArtifacts.Subagents)
	}
	if !strings.Contains(resp.ClaudeArtifacts.Subagents[0].Content, "name: reviewer") {
		t.Errorf("content missing: %q", resp.ClaudeArtifacts.Subagents[0].Content)
	}
	if resp.ClaudeArtifacts.Commands[0].Status != "unchanged" || resp.ClaudeArtifacts.Commands[0].Content != "" {
		t.Errorf("unchanged command should carry no content: %+v", resp.ClaudeArtifacts.Commands[0])
	}
	if got.Artifacts["subagent"]["reviewer"] != "old" {
		t.Errorf("request digests not sent: %+v", got.Artifacts)
	}
}

func TestSyncBootstrap_LegacyResponseHasNilArtifacts(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","agents":{"status":"updated","content":"# CLAUDE.md\n"}}`))
	})
	resp, err := c.SyncBootstrap(context.Background(), BundleRequest{Engine: "claude"})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if resp.ClaudeArtifacts != nil {
		t.Error("legacy server omits claude_artifacts; field must stay nil")
	}
	if string(resp.Agents) != "# CLAUDE.md\n" {
		t.Errorf("legacy agents still decodes: %q", string(resp.Agents))
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

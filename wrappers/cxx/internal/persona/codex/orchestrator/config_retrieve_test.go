package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/user"
	"testing"
)

// captureConfigRequest runs one RetrieveConfig call against a stub server and
// returns the method, path and decoded JSON body it posted.
func captureConfigRequest(t *testing.T, digest string) (method, path string, body map[string]any) {
	t.Helper()
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("decode request body %q: %v", raw, err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok",
			"data":   map[string]any{"status": "updated", "content": "model = \"gpt-5.4\"\n"},
		})
	})
	if _, err := c.RetrieveConfig(context.Background(), digest); err != nil {
		t.Fatalf("retrieve config: %v", err)
	}
	return method, path, body
}

// TestRetrieveConfigPostsCodexScopedRequest pins the engine literal that picks
// the rendered document: this binary is the Codex wrapper, so a copied "claude"
// would write Claude's settings.json into ~/.codex/config.toml.
func TestRetrieveConfigPostsCodexScopedRequest(t *testing.T) {
	method, path, body := captureConfigRequest(t, "abc123")
	if method != http.MethodPost || path != "/config/retrieve" {
		t.Fatalf("request = %s %s, want POST /config/retrieve", method, path)
	}
	if body["engine"] != "codex" {
		t.Fatalf("engine = %v, want codex", body["engine"])
	}
	if body["sha256"] != "abc123" {
		t.Fatalf("sha256 = %v, want abc123", body["sha256"])
	}
}

// TestRetrieveConfigOmitsEmptyDigest keeps the key absent rather than empty: the
// server reads a present sha256 as "the host already holds this revision", so an
// empty one would let it answer unchanged and starve a host with no config.toml.
func TestRetrieveConfigOmitsEmptyDigest(t *testing.T) {
	_, _, body := captureConfigRequest(t, "")
	if _, ok := body["sha256"]; ok {
		t.Fatalf("sha256 sent for an empty digest: %v", body)
	}
	if body["engine"] != "codex" {
		t.Fatalf("engine = %v, want codex", body["engine"])
	}
}

// TestRetrieveConfigSendsHostHints pins the home/username hints the server needs
// to bake this host's `[projects."<home>"] trust_level=trusted` stanza (see
// docs/interface-cdx.md "Config Bake Rules"): drop them and codex re-prompts for
// trust in the operator's own home directory on every launch.
func TestRetrieveConfigSendsHostHints(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	wantHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("user home dir: %v", err)
	}
	wantUser, err := user.Current()
	if err != nil {
		t.Fatalf("current user: %v", err)
	}
	_, _, body := captureConfigRequest(t, "abc123")
	if body["home"] != wantHome {
		t.Fatalf("home = %v, want %q", body["home"], wantHome)
	}
	if body["username"] != wantUser.Username {
		t.Fatalf("username = %v, want %q", body["username"], wantUser.Username)
	}
}

func TestRetrieveConfigPropagatesHTTPError(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"status":"error","code":"engine_disabled","message":"engine disabled"}`))
	})
	body, err := c.RetrieveConfig(context.Background(), "abc123")
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

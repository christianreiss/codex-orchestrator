package grok

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
)

// Exercise the actual Grok launch lifecycle, including its private runtime and
// account lease, rather than invoking the identity helpers independently.
func TestNativeLaunchRequiresRegisteredIdentityBeforeProvider(t *testing.T) {
	for _, named := range []bool{true, false} {
		t.Run(map[bool]string{true: "confirmed", false: "missing-name"}[named], func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("HOME", dir)
			t.Setenv("GROK_HOME", filepath.Join(dir, "grok"))
			t.Setenv("XDG_RUNTIME_DIR", dir)
			for _, key := range []string{"GROK_CONFIG", "GROK_CONFIG_PATH", "CXX_AGENT_MESSAGING_ADDRESS", "CXX_REBOOT_REQUEST_ID", "CXX_DAEMON_OPERATION_ID"} {
				t.Setenv(key, "")
			}
			registered, confirmed, started := filepath.Join(dir, "registered"), filepath.Join(dir, "confirmed"), filepath.Join(dir, "started")
			t.Setenv("CXX_TEST_REGISTERED", registered)
			t.Setenv("CXX_TEST_CONFIRMED", confirmed)
			t.Setenv("CXX_TEST_STARTED", started)
			cli := filepath.Join(dir, "grok-cli")
			script := `#!/bin/sh
if [ "$1" = --version ]; then echo 'grok 1.0.50'; exit 0; fi
[ -f "$CXX_TEST_REGISTERED" ] && [ -f "$CXX_TEST_CONFIRMED" ] || exit 91
[ -n "$CXX_AGENT_PORTAL_SOCKET" ] && [ -n "$CXX_AGENT_PORTAL_SESSION_ID" ] || exit 92
: > "$CXX_TEST_STARTED"
printf 'name=%s\nsession=%s\n' "$CXX_AGENT_NAME" "$CXX_AGENT_PORTAL_SESSION_ID"
printf '%s\n' "$@"
`
			if err := os.WriteFile(cli, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CGX_GROK_BIN", cli)
			const uuid = "12345678-1234-4123-8123-123456789abc"
			const token = "fixture-access"
			expires := time.Now().UTC().Add(time.Hour)
			auth := map[string]any{"grok_scope": native.OfficialScope, "grok_auth": map[string]any{native.OfficialScope: map[string]any{
				"key": token, "auth_mode": "external", "expires_at": expires, "oidc_issuer": "https://auth.x.ai", "oidc_client_id": native.OfficialClientID,
			}}}
			digest := sha256.Sum256([]byte(token))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				switch {
				case r.URL.Path == "/sync/bootstrap":
					_, _ = w.Write([]byte(`{"status":"ok","grok_skills":[]}`))
				case r.URL.Path == "/auth":
					_ = json.NewEncoder(w).Encode(map[string]any{"status": "available", "account_pool": true, "verification_state": "verified"})
				case r.URL.Path == "/auth/sessions":
					_ = json.NewEncoder(w).Encode(map[string]any{"account_id": 7001, "session_id": body["session_id"], "verification_state": "verified", "auth": auth, "canonical_generation": 17, "access_token_digest": hex.EncodeToString(digest[:]), "access_expires_at": expires.Format(time.RFC3339Nano)})
				case r.URL.Path == "/host/agent-sessions":
					if body["engine"] != "grok" || body["invocation_kind"] != "execute" {
						t.Errorf("wrong launch registration: %v", body)
					}
					name := "Claudia"
					if !named {
						name = ""
					}
					if err := os.WriteFile(registered, []byte(body["session_id"].(string)), 0o600); err != nil {
						t.Error(err)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"enabled": true, "session_id": body["session_id"], "bridge_token": body["bridge_token"], "agent_address": map[string]any{"name": name, "address": "agent:" + uuid, "binding_generation": 1}})
				case strings.HasSuffix(r.URL.Path, "/agent-messaging/self"):
					id, err := os.ReadFile(registered)
					if err != nil || r.Header.Get("X-Agent-Bridge-Token") == "" || r.Header.Get("X-API-Key") != "" {
						t.Error("self confirmation did not follow bridge registration")
					}
					if err := os.WriteFile(confirmed, nil, 0o600); err != nil {
						t.Error(err)
					}
					_ = json.NewEncoder(w).Encode(agentportal.Identity{Version: 1, Name: "Claudia", UUID: uuid, Address: "agent:" + uuid, SessionID: string(id), Engine: "grok"})
				case strings.HasSuffix(r.URL.Path, "/agent-messaging/list"):
					_, _ = w.Write([]byte(`{"scope":"project","effective_scope":"project","addresses":[],"total":0}`))
				case r.URL.Path == "/host/users", r.URL.Path == "/auth/sessions/release", strings.HasSuffix(r.URL.Path, "/heartbeat"), strings.HasSuffix(r.URL.Path, "/finish"), strings.HasSuffix(r.URL.Path, "/native-control"):
					_, _ = w.Write([]byte(`{}`))
				default:
					t.Errorf("unexpected launch request: %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			cfg := &config.Config{Engine: config.EngineGrok, Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture-host-key"}, AgentMessaging: config.AgentMessaging{Enabled: true}}
			client, err := newClient(cfg)
			if err != nil {
				t.Fatal(err)
			}
			o, err := nativeOptions([]string{"--print", "Keep this prompt"})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			var stdout, stderr bytes.Buffer
			code, err := run(ctx, cfg, client, o, &stdout, &stderr)
			if !named {
				if code != 1 || err == nil || !strings.Contains(err.Error(), "no confirmed name") {
					t.Fatalf("unnamed launch: code=%d error=%v stderr=%s", code, err, &stderr)
				}
				if _, err := os.Stat(started); !os.IsNotExist(err) {
					t.Fatal("provider started without a confirmed name")
				}
				return
			}
			if code != 0 || err != nil {
				t.Fatalf("named launch: code=%d error=%v stderr=%s", code, err, &stderr)
			}
			id, err := os.ReadFile(registered)
			if err != nil {
				t.Fatal(err)
			}
			for _, value := range []string{"name=Claudia", "session=" + string(id), "--rules\n", "your name is Claudia", "launch session ID is " + string(id), "agent_self", "Keep this prompt"} {
				if !strings.Contains(stdout.String(), value) {
					t.Errorf("provider did not receive %q: %s", value, &stdout)
				}
			}
		})
	}
}

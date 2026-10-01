package grok

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func loginFixture(t *testing.T) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"last_refresh": time.Now().UTC(), "grok_auth": map[string]any{native.OfficialScope: map[string]any{
		"key": "fresh-access-fixture", "refresh_token": "fresh-unaccepted-refresh-fixture", "auth_mode": "oidc",
		"oidc_issuer": "https://auth.x.ai", "oidc_client_id": native.OfficialClientID, "expires_at": time.Now().Add(time.Hour).UTC(),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestLoginRetriesOnlyLockedHeadConflictOnce(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid upload")
			w.WriteHeader(400)
			return
		}
		if r.URL.Path != "/auth" || body["command"] != "store" || body["engine"] != "grok" || body["session_id"] != nil {
			t.Error("login retained runtime binding")
		}
		if calls == 1 {
			if body["base_canonical_generation"] != nil || body["account_id"] != nil {
				t.Error("first login was already account-bound")
			}
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"error":{"code":"grok_generation_conflict","account_id":7001,"canonical_generation":17}}`))
			return
		}
		if body["account_id"] != float64(7001) || body["base_canonical_generation"] != float64(17) {
			t.Error("CAS retry did not use locked head")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified"}`))
	}))
	defer server.Close()
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	if err := uploadLogin(context.Background(), client, loginFixture(t)); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("login calls=%d, want2", calls)
	}
}

func TestPendingLoginSecureRetryAndInsecureCleanup(t *testing.T) {
	for _, secure := range []bool{true, false} {
		t.Run(map[bool]string{true: "secure", false: "insecure"}[secure], func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv("GROK_HOME", filepath.Join(t.TempDir(), "native"))
			auth := loginFixture(t)
			var envelope struct {
				Native json.RawMessage `json:"grok_auth"`
			}
			_ = json.Unmarshal(auth, &envelope)
			cli := filepath.Join(t.TempDir(), "grok")
			script := "#!/bin/sh\n[ \"$1\" = login ] || exit 9\ncat >\"$GROK_AUTH_PATH\" <<'CGX_FIXTURE'\n" + string(envelope.Native) + "\nCGX_FIXTURE\n"
			if err := os.WriteFile(cli, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CGX_GROK_BIN", cli)
			fail := true
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["session_id"] != nil || body["account_id"] != nil {
					t.Error("fresh login reused active binding")
				}
				w.Header().Set("Content-Type", "application/json")
				if fail {
					w.WriteHeader(503)
					_, _ = w.Write([]byte(`{"error":{"code":"grok_refresh_uncertain","message":"credential-must-not-escape"}}`))
					return
				}
				_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified"}`))
			}))
			defer server.Close()
			previous := &accountpool.Context{Engine: "grok", AccountID: 99, SessionID: "active-original"}
			client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client(), Pool: previous}
			cfg := &config.Config{Host: config.Host{Secure: secure}, Orchestrator: config.Orchestrator{BaseURL: server.URL}}
			var out, errout bytes.Buffer
			err := login(context.Background(), cfg, client, nil, &out, &errout)
			if err == nil || strings.Contains(err.Error(), "credential-must-not-escape") {
				t.Fatal("failure was not sanitized")
			}
			if client.Pool != previous {
				t.Fatal("active account binding changed")
			}
			path, _ := pendingLoginPath()
			info, statErr := os.Stat(path)
			if !secure {
				if !os.IsNotExist(statErr) {
					t.Fatal("insecure host retained refresh material")
				}
				return
			}
			if statErr != nil || info.Mode().Perm() != 0o600 {
				t.Fatal("pending login not protected")
			}
			pending, err := readPendingLogin()
			if err != nil || validateLogin(pending.Auth) != nil {
				t.Fatal("fresh pending login unavailable")
			}
			fail = false
			if err := login(context.Background(), cfg, client, []string{"retry"}, &out, &errout); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("accepted pending login not erased")
			}
		})
	}
}

func TestPendingLoginExpiresAndRuntimeProjectionCannotBeRetried(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path, _ := pendingLoginPath()
	pending := pendingLogin{Version: 1, CreatedAt: time.Now().Add(-25 * time.Hour), Auth: loginFixture(t)}
	raw, _ := json.Marshal(pending)
	if err := native.AtomicWrite(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readPendingLogin(); err == nil {
		t.Fatal("expired login accepted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("expired refresh material retained")
	}
	var doc map[string]any
	_ = json.Unmarshal(loginFixture(t), &doc)
	cred := doc["grok_auth"].(map[string]any)[native.OfficialScope].(map[string]any)
	cred["auth_mode"] = "external"
	delete(cred, "refresh_token")
	raw, _ = json.Marshal(doc)
	if validateLogin(raw) == nil {
		t.Fatal("access-only projection accepted as fresh login")
	}
}

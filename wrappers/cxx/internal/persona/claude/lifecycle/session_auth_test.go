package lifecycle

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

func sessionFixture(t *testing.T) (string, json.RawMessage) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	old := sessionPayload("old", time.Now().Add(-2*time.Hour))
	if err := claude.WriteAuth(old); err != nil {
		t.Fatal(err)
	}
	path, _ := claude.AuthPath()
	return path, sessionPayload("remote", time.Now().Add(-time.Hour))
}

func sessionPayload(token string, stamp time.Time) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"last_refresh":%q,"claudeAiOauth":{"accessToken":%q,"refreshToken":"fixture-refresh"}}`, stamp.UTC().Format(time.RFC3339Nano), token))
}

func sessionClient(t *testing.T, handler http.HandlerFunc) *orchestrator.Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "fixture", Logger: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func canonicalSessionResponse(w http.ResponseWriter, auth json.RawMessage, verification string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "outdated", "auth": auth, "canonical_digest": strings.Repeat("b", 64), "canonical_last_refresh": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano), "verification_state": verification})
}

func TestSessionAuthPullsVerifiedCanonicalIntoAnUnchangedGeneration(t *testing.T) {
	path, remote := sessionFixture(t)
	client := sessionClient(t, func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		if body["command"] != "retrieve" || body["engine"] != "claude" || body["digest"] == nil || body["last_refresh"] != nil {
			t.Errorf("unsafe session retrieve shape: %v", body)
		}
		canonicalSessionResponse(w, remote, "verified")
	})
	result, err := SyncSessionAuth(context.Background(), client, nil)
	if err != nil || !result.Adopted || result.Uploaded || result.Deferred {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `"remote"`) {
		t.Fatal("verified remote credentials were not adopted")
	}
	snap, _ := claude.ReadAuthSnapshot(false)
	if snap.Generation != result.Generation || snap.ServerDigest != strings.Repeat("b", 64) {
		t.Fatal("adopted generation lost its canonical binding")
	}
}

func TestSessionAuthPreservesEveryNativeChangeDuringRetrieve(t *testing.T) {
	for _, change := range []string{"login", "delete", "invalid", "canonical", "logout"} {
		t.Run(change, func(t *testing.T) {
			path, remote := sessionFixture(t)
			before, _ := claude.ReadAuthSnapshot(false)
			var expected []byte
			client := sessionClient(t, func(w http.ResponseWriter, _ *http.Request) {
				switch change {
				case "login":
					_ = os.WriteFile(path, sessionPayload("manual", time.Now()), 0o600)
				case "delete":
					_ = os.Remove(path)
				case "invalid":
					_ = os.WriteFile(path, []byte("{"), 0o600)
				case "canonical":
					// Even a wrapper-managed generation that arrived first wins;
					// session sync never retries the CAS against different bytes.
					_ = claude.WriteAuth(sessionPayload("other-response", time.Now().Add(-90*time.Minute)))
				case "logout":
					_, _ = claude.RecordDeferredExplicitLogout(before.Generation)
				}
				expected, _ = os.ReadFile(path)
				canonicalSessionResponse(w, remote, "verified")
			})
			result, err := SyncSessionAuth(context.Background(), client, nil)
			if err != nil || result.Adopted || !result.Deferred {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			actual, _ := os.ReadFile(path)
			if string(actual) != string(expected) {
				t.Fatal("session sync overwrote a native change")
			}
		})
	}
}

func TestSessionAuthRetainsPendingLocalCandidateAfterStoreFailure(t *testing.T) {
	path, _ := sessionFixture(t)
	native := sessionPayload("pending-login", time.Now())
	_ = os.WriteFile(path, native, 0o600)
	client := sessionClient(t, func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		if body["command"] != "store" {
			t.Error("unacknowledged native candidate was bypassed by a retrieve")
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"status":"error","code":"candidate_unverifiable_expired"}`)
	})
	result, err := SyncSessionAuth(context.Background(), client, nil)
	if err == nil || result.Adopted || result.Uploaded {
		t.Fatalf("failed candidate was acknowledged: %+v %v", result, err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != string(native) {
		t.Fatal("failed candidate was lost")
	}
}

func TestSessionAuthAcknowledgesVerifiedUploadWithoutNativeRewrite(t *testing.T) {
	path, _ := sessionFixture(t)
	native := sessionPayload("native-login", time.Now())
	_ = os.WriteFile(path, native, 0o600)
	commands := []string{}
	client := sessionClient(t, func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		commands = append(commands, body["command"].(string))
		_, _ = fmt.Fprintf(w, `{"status":"valid","verification_state":"verified","canonical_digest":%q}`, strings.Repeat("c", 64))
	})
	first, err := SyncSessionAuth(context.Background(), client, nil)
	if err != nil || !first.Uploaded || first.Adopted {
		t.Fatalf("upload=%+v err=%v", first, err)
	}
	if _, err := SyncSessionAuth(context.Background(), client, nil); err != nil {
		t.Fatal(err)
	}
	if strings.Join(commands, ",") != "store,retrieve" {
		t.Fatalf("accepted generation repeatedly uploaded: %v", commands)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != string(native) {
		t.Fatal("acknowledgement rewrote native credentials")
	}
}

func TestSessionAuthNeverBootstrapsAbsentInvalidOrLoggedOutCredentials(t *testing.T) {
	for _, state := range []string{"absent", "invalid", "logout", "pending-canonical"} {
		t.Run(state, func(t *testing.T) {
			path, remote := sessionFixture(t)
			switch state {
			case "absent":
				_ = os.Remove(path)
			case "invalid":
				_ = os.WriteFile(path, []byte("null"), 0o600)
			case "logout":
				snap, _ := claude.ReadAuthSnapshot(false)
				_, _ = claude.RecordDeferredExplicitLogout(snap.Generation)
			}
			before, _ := os.ReadFile(path)
			client := sessionClient(t, func(w http.ResponseWriter, _ *http.Request) {
				if state != "pending-canonical" {
					t.Error("inactive credentials caused a network request")
				}
				canonicalSessionResponse(w, remote, "pending")
			})
			result, err := SyncSessionAuth(context.Background(), client, nil)
			if result.Adopted || (state == "pending-canonical" && err == nil) {
				t.Fatalf("unsafe canonical adopted: %+v %v", result, err)
			}
			after, _ := os.ReadFile(path)
			if string(before) != string(after) {
				t.Fatal("inactive credentials were restored")
			}
			if entries, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "*.new")); len(entries) > 0 {
				t.Fatal("aborted sync left staged credentials")
			}
		})
	}
}

func TestSessionAuthPreservesLocalExtrasAndNeverTransfersThem(t *testing.T) {
	path, _ := sessionFixture(t)
	native := []byte(`{"claudeAiOauth":{"accessToken":"pending","refreshToken":"fixture-refresh","newNativeField":{"required":true}},"mcpOAuth":{"private-server":{"accessToken":"local-mcp-secret"}},"auths":{"local.example":{"token":"local-key"}},"tokens":{"unrelated":"local-token"}}`)
	_ = os.WriteFile(path, native, 0o600)
	client := sessionClient(t, func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		for _, forbidden := range []string{"local-mcp-secret", "local-key", "local-token", "mcpOAuth"} {
			if strings.Contains(string(body), forbidden) {
				t.Errorf("outgoing account leaked local extra %q", forbidden)
			}
		}
		if !strings.Contains(string(body), "newNativeField") {
			t.Error("unknown OAuth account field was stripped")
		}
		_, _ = fmt.Fprintf(w, `{"status":"updated","verification_state":"verified","canonical_digest":%q,"auth":{"last_refresh":%q,"claudeAiOauth":{"accessToken":"replacement","refreshToken":"fixture-refresh","newNativeField":{"required":true}},"mcpOAuth":{"foreign":"remote-secret"},"other":"remote-extra"}}`, strings.Repeat("d", 64), time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	})
	result, err := SyncSessionAuth(context.Background(), client, nil)
	if err != nil || !result.Adopted {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	raw, _ := os.ReadFile(path)
	for _, required := range []string{"replacement", "newNativeField", "local-mcp-secret", "local-key", "local-token"} {
		if !strings.Contains(string(raw), required) {
			t.Errorf("local native field lost: %s", required)
		}
	}
	if strings.Contains(string(raw), "remote-secret") || strings.Contains(string(raw), "remote-extra") {
		t.Fatal("another host's native extras were imported")
	}
	snap, _ := claude.ReadAuthSnapshot(false)
	if snap.Generation != result.Generation {
		t.Fatal("adopted generation excludes preserved local extras")
	}
}

func TestSessionAuthLocalMCPOnlyChangeDoesNotUploadAccountOrRestampRefresh(t *testing.T) {
	path, remote := sessionFixture(t)
	before, _ := claude.ReadAuthSnapshot(false)
	var local map[string]any
	_ = json.Unmarshal(before.Raw, &local)
	local["mcpOAuth"] = map[string]any{"local": "changed-only-here"}
	changed, _ := json.Marshal(local)
	_ = os.WriteFile(path, changed, 0o600)
	client := sessionClient(t, func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		if body["command"] != "retrieve" || body["digest"] != before.ServerDigest {
			t.Errorf("MCP-only change became account upload: %v", body)
		}
		// An additional native edit during retrieve must win the full-file CAS.
		local["mcpOAuth"] = map[string]any{"local": "concurrent-edit"}
		bytes, _ := json.Marshal(local)
		_ = os.WriteFile(path, bytes, 0o600)
		canonicalSessionResponse(w, remote, "verified")
	})
	result, err := SyncSessionAuth(context.Background(), client, nil)
	if err != nil || result.Adopted || !result.Deferred {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	snap, _ := claude.ReadAuthSnapshot(false)
	if !strings.Contains(string(snap.Raw), "concurrent-edit") || !snap.LastRefresh.Equal(before.LastRefresh) {
		t.Fatal("MCP edit lost or account refresh restamped")
	}
}

func TestSessionSyncRejectsCrossEngineAuthBeforeHostSecurityCanChange(t *testing.T) {
	path, remote := sessionFixture(t)
	before, _ := os.ReadFile(path)
	client := sessionClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "outdated", "engine": "codex", "verification_state": "verified", "host": map[string]bool{"secure": false}, "auth": remote})
	})
	result, err := SyncSessionAuth(context.Background(), client, nil)
	if err == nil || result.HostSecure != nil || result.Adopted {
		t.Fatalf("cross-engine metadata escaped: %+v %v", result, err)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Fatal("cross-engine auth changed native file")
	}
	session, err := claude.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	if err := updateAuthSessionSecurityContext(context.Background(), session, &orchestrator.AuthRetrieveResponse{Engine: "codex", Host: &orchestrator.HostInfo{Secure: false}}); err == nil {
		t.Fatal("cross-engine security update accepted")
	}
	if purged, err := session.CloseAndPurgeIfLast(); err != nil || purged {
		t.Fatalf("cross-engine response changed purge policy: %v %v", purged, err)
	}
}

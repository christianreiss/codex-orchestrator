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
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

const sessionAuthOld = `{"last_refresh":"2026-08-08T10:00:00Z","tokens":{"access_token":"old"}}`
const sessionAuthNew = `{"last_refresh":"2026-08-08T11:00:00Z","tokens":{"access_token":"new"}}`
const sessionAuthNative = `{"last_refresh":"2026-08-08T12:00:00Z","tokens":{"access_token":"native"}}`

func sessionAuthClient(t *testing.T, known bool, handler http.HandlerFunc) (*orchestrator.Client, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	path, _ := codex.AuthPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if known {
		if err := codex.WriteAuth(json.RawMessage(sessionAuthOld)); err != nil {
			t.Fatal(err)
		}
	} else if err := os.WriteFile(path, []byte(sessionAuthOld), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, Logger: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	return client, path
}

func sessionAuthReply(w http.ResponseWriter, status, verification, payload string) {
	w.Header().Set("Content-Type", "application/json")
	body := map[string]any{"status": status, "verification_state": verification, "engine": "codex"}
	if payload != "" {
		body["auth"] = json.RawMessage(payload)
	}
	_ = json.NewEncoder(w).Encode(body)
}

func TestSessionAuthUploadsUnboundGenerationBeforePullAndBindsAcceptance(t *testing.T) {
	var commands []string
	client, _ := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Command string          `json:"command"`
			Auth    json.RawMessage `json:"auth"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		commands = append(commands, body.Command)
		if len(commands) == 1 && (body.Command != "store" || !strings.Contains(string(body.Auth), `"access_token":"old"`)) {
			t.Error("native generation was not offered first")
		}
		sessionAuthReply(w, "valid", "verified", "")
	})
	first, err := SyncSessionAuth(context.Background(), client, slog.Default())
	if err != nil || !first.Uploaded || first.Adopted || first.Deferred {
		t.Fatalf("initial store: %+v %v", first, err)
	}
	bound, err := codex.IsCanonicalAuthGeneration(first.Generation)
	if err != nil || !bound {
		t.Fatalf("accepted generation remains unbound: %v %v", bound, err)
	}
	second, err := SyncSessionAuth(context.Background(), client, slog.Default())
	if err != nil || second.Uploaded || second.Adopted {
		t.Fatalf("bound pull: %+v %v", second, err)
	}
	if len(commands) != 2 || commands[0] != "store" || commands[1] != "retrieve" {
		t.Fatalf("commands=%v", commands)
	}
}

func TestSessionAuthPullAdoptsVerifiedNewerCanonicalWhileChildActive(t *testing.T) {
	client, path := sessionAuthClient(t, true, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["command"] != "retrieve" || body["digest"] == "" || body["last_refresh"] != nil {
			t.Errorf("pull must be digest-only: %#v", body)
		}
		sessionAuthReply(w, "outdated", "verified", sessionAuthNew)
	})
	child, err := codex.AcquireActiveChild()
	if err != nil {
		t.Fatal(err)
	}
	defer child.Release()
	got, err := SyncSessionAuth(context.Background(), client, nil)
	if err != nil || !got.Adopted || got.Uploaded || got.Deferred {
		t.Fatalf("pull = %+v %v", got, err)
	}
	raw, _ := os.ReadFile(path)
	current, _ := codex.CurrentAuthGeneration()
	if string(raw) != sessionAuthNew || got.Generation != current {
		t.Fatal("adoption did not identify exact installed bytes")
	}
}

func TestSessionAuthMissingServerCanonicalOffersExistingBoundCandidate(t *testing.T) {
	var calls atomic.Int32
	client, _ := sessionAuthClient(t, true, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Command string `json:"command"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if calls.Add(1) == 1 {
			if body.Command != "retrieve" {
				t.Error("known candidate was not retrieved first")
			}
			sessionAuthReply(w, "missing", "", "")
			return
		}
		if body.Command != "store" {
			t.Error("missing canonical did not request store")
		}
		sessionAuthReply(w, "updated", "verified", "")
	})
	result, err := SyncSessionAuth(context.Background(), client, nil)
	if err != nil || !result.Uploaded || result.Deferred || calls.Load() != 2 {
		t.Fatalf("missing canonical recovery=%+v calls=%d err=%v", result, calls.Load(), err)
	}
}

func TestSessionAuthRejectsOtherEngineBeforeSecurityAndCredentialChanges(t *testing.T) {
	for _, known := range []bool{false, true} {
		t.Run(map[bool]string{false: "store", true: "retrieve"}[known], func(t *testing.T) {
			client, path := sessionAuthClient(t, known, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "updated", "verification_state": "verified", "engine": "claude", "host": map[string]bool{"secure": false}, "auth": json.RawMessage(sessionAuthNew)})
			})
			session, err := codex.StartAuthSession(false)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := SyncSessionAuth(context.Background(), client, nil); err == nil {
				t.Error("other engine accepted")
			}
			if removed, _, err := codex.FinishAuthSession(session); err != nil || removed {
				t.Fatalf("other engine changed host purge policy: removed=%v err=%v", removed, err)
			}
			raw, err := os.ReadFile(path)
			if err != nil || string(raw) != sessionAuthOld {
				t.Fatal("other engine changed native credentials")
			}
		})
	}
}

func TestPostRunAuthResponsePreservesConcurrentNativeChange(t *testing.T) {
	for _, action := range []string{"login", "partial write", "logout"} {
		t.Run(action, func(t *testing.T) {
			var path string
			client, localPath := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) {
				switch action {
				case "login":
					_ = os.WriteFile(path, []byte(sessionAuthOld), 0o600)
				case "partial write":
					_ = os.WriteFile(path, []byte(`{"tokens":`), 0o600)
				case "logout":
					_ = os.Remove(path)
				}
				sessionAuthReply(w, "updated", "verified", sessionAuthNative)
			})
			path = localPath
			beforeHash, beforeRefresh := snapshotAuth(path)
			if err := os.WriteFile(path, []byte(sessionAuthNew), 0o600); err != nil {
				t.Fatal(err)
			}
			status, _, err := postRunAuthUploadAttempt(context.Background(), client, slog.Default(), path, beforeHash, beforeRefresh)
			if action == "logout" {
				if err != nil || status != "logged out" {
					t.Fatalf("post-run logout = %s %v", status, err)
				}
			} else if err == nil || status != "newer auth pending" {
				t.Fatalf("post-run %s = %s %v", action, status, err)
			}
			raw, err := os.ReadFile(path)
			switch action {
			case "login":
				if string(raw) != sessionAuthOld {
					t.Fatal("manual login replaced by response")
				}
			case "partial write":
				if string(raw) != `{"tokens":` {
					t.Fatal("native partial write replaced by response")
				}
			case "logout":
				if !os.IsNotExist(err) {
					t.Fatal("native logout restored by response")
				}
			}
		})
	}
}

func TestPostRunUnchangedUnboundAuthRetriesBeforeInsecurePurge(t *testing.T) {
	var calls atomic.Int32
	client, path := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) <= 2 {
			http.Error(w, "runner temporarily unavailable", http.StatusServiceUnavailable)
			return
		}
		var body struct {
			Command string          `json:"command"`
			Auth    json.RawMessage `json:"auth"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Command != "store" || !strings.Contains(string(body.Auth), `"access_token":"old"`) {
			t.Error("final request lost unchanged native candidate")
		}
		sessionAuthReply(w, "updated", "verified", "")
	})
	session, err := codex.StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	defer codex.FinishAuthSession(session)
	beforeHash, beforeRefresh := snapshotAuth(path)
	if _, err := SyncSessionAuth(context.Background(), client, nil); err == nil {
		t.Fatal("watcher fixture should fail before final upload")
	}
	status, _, err := maybePostRunAuthUpload(client, slog.Default(), path, beforeHash, beforeRefresh)
	if err != nil || status != "uploaded" || calls.Load() != 3 {
		t.Fatalf("unchanged final upload=%q calls=%d err=%v", status, calls.Load(), err)
	}
	generation, _ := codex.CurrentAuthGeneration()
	if known, err := codex.IsCanonicalAuthGeneration(generation); err != nil || !known {
		t.Fatalf("final accepted candidate unbound=%v err=%v", known, err)
	}
	if removed, _, err := codex.FinishAuthSession(session); err != nil || !removed {
		t.Fatalf("required purge after acceptance=%v err=%v", removed, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("insecure final session retained credentials")
	}
}

func TestPostRunRetriesNewNativeGenerationBeforeFinalPurge(t *testing.T) {
	for _, keepsRotating := range []bool{false, true} {
		t.Run(map[bool]string{false: "rotation settles", true: "bounded persistent rotation"}[keepsRotating], func(t *testing.T) {
			var calls atomic.Int32
			var path string
			client, localPath := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					Auth json.RawMessage `json:"auth"`
				}
				_ = json.NewDecoder(r.Body).Decode(&request)
				call := calls.Add(1)
				if call == 1 || keepsRotating {
					raw := []byte(fmt.Sprintf(`{"last_refresh":"2026-08-08T12:00:00Z","tokens":{"access_token":"native-%d"}}`, call))
					if err := os.WriteFile(path, raw, 0o600); err != nil {
						t.Error(err)
					}
				} else if !strings.Contains(string(request.Auth), `"access_token":"native-1"`) {
					t.Error("final retry did not offer newer native generation")
				}
				sessionAuthReply(w, "updated", "verified", string(request.Auth))
			})
			path = localPath
			beforeHash, beforeRefresh := snapshotAuth(path)
			if err := os.WriteFile(path, []byte(sessionAuthNew), 0o600); err != nil {
				t.Fatal(err)
			}
			session, err := codex.StartAuthSession(true)
			if err != nil {
				t.Fatal(err)
			}
			defer codex.FinishAuthSession(session)
			status, _, err := maybePostRunAuthUpload(client, slog.Default(), path, beforeHash, beforeRefresh)
			if keepsRotating {
				if err == nil || calls.Load() != 3 || status != "newer auth pending" {
					t.Fatalf("unconfirmed rotation reported success: status=%s calls=%d err=%v", status, calls.Load(), err)
				}
			} else {
				if err != nil || calls.Load() != 2 || status != "uploaded" {
					t.Fatalf("settled rotation final sync: status=%s calls=%d err=%v", status, calls.Load(), err)
				}
				generation, _ := codex.CurrentAuthGeneration()
				if known, err := codex.IsCanonicalAuthGeneration(generation); err != nil || !known {
					t.Fatal("latest native rotation remained unbound before purge")
				}
			}
		})
	}
}

func TestSessionAuthBindsAcceptedIdentityDespiteOlderCanonicalTimestamp(t *testing.T) {
	older := `{"last_refresh":"2026-08-08T09:00:00Z","tokens":{"access_token":"old"}}`
	client, path := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) { sessionAuthReply(w, "valid", "verified", older) })
	got, err := SyncSessionAuth(context.Background(), client, slog.Default())
	if err != nil || !got.Uploaded || got.Adopted || !got.Deferred {
		t.Fatalf("accepted older envelope = %+v %v", got, err)
	}
	bound, err := codex.IsCanonicalAuthGeneration(got.Generation)
	if err != nil || !bound {
		t.Fatalf("accepted identity remained unbound: %v %v", bound, err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != sessionAuthOld {
		t.Fatal("older envelope replaced newer local timestamp")
	}
}

func TestSessionAuthPreservesConcurrentNativeWritesAndLogout(t *testing.T) {
	for _, action := range []string{"login", "partial write", "native logout", "explicit logout"} {
		t.Run(action, func(t *testing.T) {
			var path string
			client, authPath := sessionAuthClient(t, true, func(w http.ResponseWriter, r *http.Request) {
				switch action {
				case "login":
					_ = os.WriteFile(path, []byte(sessionAuthNative), 0o600)
				case "partial write":
					_ = os.WriteFile(path, []byte(`{"tokens":`), 0o600)
				case "native logout":
					_ = os.Remove(path)
				case "explicit logout":
					current, _ := codex.CurrentAuthGeneration()
					_, err := codex.MarkLogoutIntent(current)
					if err != nil {
						t.Error(err)
					}
				}
				sessionAuthReply(w, "outdated", "verified", sessionAuthNew)
			})
			path = authPath
			before, _ := codex.CurrentAuthGeneration()
			got, err := SyncSessionAuth(context.Background(), client, slog.Default())
			if err != nil || got.Adopted || !got.Deferred || got.Generation != before {
				t.Fatalf("raced pull = %+v %v", got, err)
			}
			raw, readErr := os.ReadFile(path)
			if action == "native logout" && !os.IsNotExist(readErr) {
				t.Fatal("native logout was resurrected")
			}
			if action == "login" && string(raw) != sessionAuthNative {
				t.Fatal("native login was overwritten")
			}
			if action == "partial write" && string(raw) != `{"tokens":` {
				t.Fatal("partial native write was overwritten")
			}
			if action == "explicit logout" {
				active, _ := codex.LogoutIntentActive()
				if !active {
					t.Fatal("explicit logout marker was cleared")
				}
			}
		})
	}
}

func TestSessionAuthCandidateFailureKeepsNativeAndRetries(t *testing.T) {
	var requests atomic.Int32
	client, path := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"status":"error","message":"runner temporarily unavailable"}`)
	})
	for range 2 {
		got, err := SyncSessionAuth(context.Background(), client, slog.Default())
		if err == nil || got.Uploaded || got.Adopted {
			t.Fatalf("failed store = %+v %v", got, err)
		}
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != sessionAuthOld || requests.Load() < 2 {
		t.Fatal("retryable candidate was lost or suppressed")
	}
}

func TestSessionAuthAcceptsCanonicalArbitrationButNotUnverifiedOrUnusablePayloads(t *testing.T) {
	for _, tc := range []struct {
		name, status, verification, payload string
		adopt                               bool
	}{
		{"canonical arbitration", "outdated", "verified", sessionAuthNew, true},
		{"pending canonical", "outdated", "pending", sessionAuthNew, false},
		{"failed canonical", "outdated", "failed", sessionAuthNew, false},
		{"malformed canonical", "outdated", "verified", `{"last_refresh":"2026-08-08T11:00:00Z","tokens":{}}`, false},
		{"invalid timestamp", "outdated", "verified", `{"last_refresh":"unknown","tokens":{"access_token":"bad"}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, path := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) {
				sessionAuthReply(w, tc.status, tc.verification, tc.payload)
			})
			got, err := SyncSessionAuth(context.Background(), client, slog.Default())
			if got.Adopted != tc.adopt || (err == nil) != tc.adopt {
				t.Fatalf("arbitration = %+v %v", got, err)
			}
			raw, _ := os.ReadFile(path)
			want := sessionAuthOld
			if tc.adopt {
				want = tc.payload
			}
			if string(raw) != want {
				t.Fatal("wrong local auth generation")
			}
		})
	}
}

func TestSessionAuthMissingInvalidAndLogoutDoNotRequestOrRestore(t *testing.T) {
	for _, state := range []string{"missing", "invalid", "logout"} {
		t.Run(state, func(t *testing.T) {
			var requests atomic.Int32
			client, path := sessionAuthClient(t, true, func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				sessionAuthReply(w, "outdated", "verified", sessionAuthNew)
			})
			switch state {
			case "missing":
				_ = os.Remove(path)
			case "invalid":
				_ = os.WriteFile(path, []byte(`{`), 0o600)
			case "logout":
				current, _ := codex.CurrentAuthGeneration()
				if _, err := codex.MarkLogoutIntent(current); err != nil {
					t.Fatal(err)
				}
			}
			got, err := SyncSessionAuth(context.Background(), client, slog.Default())
			if err != nil || !got.Deferred || requests.Load() != 0 {
				t.Fatalf("inactive state = %+v %v requests=%d", got, err, requests.Load())
			}
		})
	}
}

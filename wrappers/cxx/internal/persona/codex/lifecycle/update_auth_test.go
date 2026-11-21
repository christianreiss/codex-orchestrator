package lifecycle

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
)

func TestUpdateAuthGuardSkipsKnownMissingInvalidAndLogout(t *testing.T) {
	for _, state := range []string{"known", "missing", "invalid", "logout"} {
		t.Run(state, func(t *testing.T) {
			var calls atomic.Int32
			client, path := sessionAuthClient(t, state == "known", func(w http.ResponseWriter, r *http.Request) { calls.Add(1); http.Error(w, "unexpected", 500) })
			switch state {
			case "missing":
				_ = os.Remove(path)
			case "invalid":
				_ = os.WriteFile(path, []byte(`{"tokens":`), 0o600)
			case "logout":
				generation, _ := codex.CurrentAuthGeneration()
				if _, err := codex.MarkLogoutIntent(generation); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := os.ReadFile(path)
			if err := UploadPendingAuthBeforeUpdate(context.Background(), client, slog.Default()); err != nil {
				t.Fatal(err)
			}
			after, _ := os.ReadFile(path)
			if calls.Load() != 0 || string(after) != string(before) {
				t.Fatalf("maintenance changed %s credentials or used network", state)
			}
		})
	}
}

func TestUpdateAuthGuardRetriesAndBindsAcceptedNativeOnly(t *testing.T) {
	var calls atomic.Int32
	client, path := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Command string          `json:"command"`
			Auth    json.RawMessage `json:"auth"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Command != "store" || !strings.Contains(string(body.Auth), `"access_token":"old"`) {
			t.Errorf("update guard must upload existing candidate only")
		}
		if calls.Add(1) == 1 {
			http.Error(w, "retry", http.StatusServiceUnavailable)
			return
		}
		sessionAuthReply(w, "updated", "verified", "")
	})
	if err := UploadPendingAuthBeforeUpdate(context.Background(), client, slog.Default()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("transient request count=%d", calls.Load())
	}
	generation, _ := codex.CurrentAuthGeneration()
	if known, err := codex.IsCanonicalAuthGeneration(generation); err != nil || !known {
		t.Fatalf("accepted native candidate unbound: %v %v", known, err)
	}
	if err := UploadPendingAuthBeforeUpdate(context.Background(), client, slog.Default()); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != sessionAuthOld || calls.Load() != 2 {
		t.Fatal("acknowledged candidate was rewritten or uploaded again")
	}
}

func TestUpdateAuthGuardPreservesNativeWhenArbitrationFails(t *testing.T) {
	for _, tc := range []struct {
		state     string
		wantError string
		wantCalls int32
	}{
		{"pending", "candidate arbitration is not verified for Codex", 3},
		{"wrong engine", "auth store response belongs to another engine", 3},
		{"unusable winner", "candidate arbitration did not converge", 3},
		{"new native", "native credentials changed during update arbitration", 1},
		{"logout", "native credentials changed during update arbitration", 1},
	} {
		t.Run(tc.state, func(t *testing.T) {
			var path string
			var calls atomic.Int32
			client, localPath := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				switch tc.state {
				case "pending":
					sessionAuthReply(w, "updated", "pending", "")
				case "wrong engine":
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified","engine":"claude"}`))
				case "unusable winner":
					sessionAuthReply(w, "outdated", "verified", `{"last_refresh":"2026-08-08T11:00:00Z"}`)
				case "new native":
					if err := os.WriteFile(path, []byte(sessionAuthNative), 0o600); err != nil {
						t.Error(err)
					}
					sessionAuthReply(w, "updated", "verified", sessionAuthNew)
				case "logout":
					if err := os.Remove(path); err != nil {
						t.Error(err)
					}
					sessionAuthReply(w, "updated", "verified", sessionAuthNew)
				}
			})
			path = localPath
			var err error
			if tc.wantCalls == 1 {
				// A retry would inspect the replacement or missing file as a new
				// decision. Check the response to the in-flight upload itself.
				err = uploadPendingAuthBeforeUpdateAttempt(t.Context(), client)
			} else {
				err = UploadPendingAuthBeforeUpdate(t.Context(), client, slog.Default())
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("arbitration error = %v, want %q", err, tc.wantError)
			}
			if n := calls.Load(); n != tc.wantCalls {
				t.Fatalf("HTTP store calls = %d, want %d", n, tc.wantCalls)
			}
			raw, err := os.ReadFile(path)
			switch tc.state {
			case "logout":
				if !os.IsNotExist(err) {
					t.Fatal("deleted native credential restored")
				}
			case "new native":
				if string(raw) != sessionAuthNative {
					t.Fatal("new native candidate changed")
				}
			default:
				if string(raw) != sessionAuthOld {
					t.Fatal("failed candidate changed")
				}
			}
		})
	}
}

func TestUpdateAuthGuardKeepsFileWhenVerifiedCanonicalWins(t *testing.T) {
	client, path := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) {
		sessionAuthReply(w, "outdated", "verified", sessionAuthNew)
	})
	if err := UploadPendingAuthBeforeUpdate(context.Background(), client, slog.Default()); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != sessionAuthOld {
		t.Fatal("maintenance materialized canonical credentials")
	}
}

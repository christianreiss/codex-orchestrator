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
	"time"

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
	for _, state := range []string{"pending", "wrong engine", "unusable winner", "new native", "logout"} {
		t.Run(state, func(t *testing.T) {
			var path string
			client, localPath := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) {
				if state == "new native" {
					_ = os.WriteFile(path, []byte(sessionAuthNative), 0o600)
				}
				if state == "logout" {
					_ = os.Remove(path)
				}
				switch state {
				case "pending":
					sessionAuthReply(w, "updated", "pending", "")
				case "wrong engine":
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified","engine":"claude"}`))
				case "unusable winner":
					sessionAuthReply(w, "outdated", "verified", `{"last_refresh":"2026-08-08T11:00:00Z"}`)
				default:
					sessionAuthReply(w, "updated", "verified", sessionAuthNew)
				}
			})
			path = localPath
			ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
			defer cancel()
			if err := UploadPendingAuthBeforeUpdate(ctx, client, slog.Default()); err == nil {
				t.Fatal("unsafe update arbitration succeeded")
			}
			raw, err := os.ReadFile(path)
			switch state {
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

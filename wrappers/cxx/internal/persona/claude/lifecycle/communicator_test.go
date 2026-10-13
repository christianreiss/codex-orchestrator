package lifecycle

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
)

func TestLostUploadAcknowledgementReadsVerifiedPairWithoutReplay(t *testing.T) {
	path, _ := sessionFixture(t)
	local := sessionPayload("unknown-upload", time.Now().Add(-time.Minute))
	if err := os.WriteFile(path, local, 0600); err != nil {
		t.Fatal(err)
	}
	client := sessionClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["command"] != "retrieve" {
			t.Fatal("unknown upload replayed")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "outdated", "account_id": 7, "verification_state": "verified", "canonical_digest": strings.Repeat("b", 64), "auth": local})
	})
	result := reconcileUnknownAuth(context.Background(), client, path, false)
	if result.Error != nil || result.Deferred || !result.Uploaded {
		t.Fatalf("readback result %+v", result)
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(local) {
		t.Fatal("readback changed native credential bytes")
	}
	snap, err := claude.ReadAuthSnapshot(false)
	if err != nil || snap.ServerDigest == "" {
		t.Fatalf("accepted pair not acknowledged: %v", err)
	}
}

func TestUnknownUploadAdoptsOnlyVerifiedNewerHead(t *testing.T) {
	for _, scenario := range []string{"newer", "equal", "older", "unverified", "wrong_engine", "wrong_account", "unbound_account", "rotated", "deleted", "logout"} {
		t.Run(scenario, func(t *testing.T) {
			path, remote := sessionFixture(t)
			before, err := claude.ReadAuthSnapshot(false)
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			var expected []byte
			client := sessionClient(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				var request map[string]any
				_ = json.NewDecoder(r.Body).Decode(&request)
				if request["command"] != "retrieve" {
					t.Error("replayed an unknown upload")
				}
				payload, verified, engine, account := remote, "verified", "claude", 1
				switch scenario {
				case "equal":
					payload = sessionPayload("different", before.LastRefresh)
				case "older":
					payload = sessionPayload("different", before.LastRefresh.Add(-time.Hour))
				case "unverified":
					verified = "pending"
				case "wrong_engine":
					engine = "codex"
				case "wrong_account":
					account = 99
				case "rotated":
					_ = os.WriteFile(path, sessionPayload("native", time.Now()), 0600)
				case "deleted":
					_ = os.Remove(path)
				case "logout":
					_, err := claude.RecordDeferredExplicitLogout(before.Generation)
					if err != nil {
						t.Error(err)
					}
				}
				expected, _ = os.ReadFile(path)
				stamp, _ := claude.LastRefreshFromRaw(payload)
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "outdated", "engine": engine, "account_id": account, "verification_state": verified, "canonical_digest": strings.Repeat("b", 64), "canonical_last_refresh": stamp.Format(time.RFC3339Nano), "auth": payload})
			})
			client.Pool = accountpool.Load("claude", path, client.BaseURL)
			client.Pool.AccountID, client.Pool.SessionID = 1, "fixture-session"
			if scenario == "unbound_account" {
				client.Pool.AccountID, client.Pool.SessionID = 0, ""
			}
			result := reconcileUnknownAuth(context.Background(), client, path, true)
			after, _ := os.ReadFile(path)
			if calls != 1 || result.Uploaded {
				t.Fatalf("not a read-only recovery: calls=%d result=%+v", calls, result)
			}
			if scenario == "newer" {
				if result.Error != nil || result.Deferred || !result.Adopted || !result.AuthSynced || !claude.SameCredentialPair(after, remote) {
					t.Fatalf("newer head not adopted: %+v", result)
				}
				snap, _ := claude.ReadAuthSnapshot(false)
				if result.Generation != snap.Generation.Digest || snap.ServerDigest != strings.Repeat("b", 64) {
					t.Fatal("adopted generation lacks canonical binding")
				}
			} else if !result.Deferred || result.Adopted || string(after) != string(expected) {
				t.Fatalf("unsafe recovery %s: %+v", scenario, result)
			}
		})
	}
}

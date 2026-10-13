package lifecycle

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
)

func TestLostUploadAcknowledgementUsesReadbackWithoutReplay(t *testing.T) {
	for _, matching := range []bool{true, false} {
		t.Run(map[bool]string{true: "committed", false: "unknown"}[matching], func(t *testing.T) {
			requests := 0
			client, path := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) {
				requests++
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["command"] != "retrieve" {
					t.Fatal("unknown upload replayed")
				}
				payload := sessionAuthOld
				if !matching {
					payload = strings.Replace(sessionAuthOld, `"old"`, `"different"`, 1)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "outdated", "engine": "codex", "account_id": 7, "verification_state": "verified", "auth": json.RawMessage(payload)})
			})
			before, _ := os.ReadFile(path)
			result := reconcileUnknownAuth(context.Background(), client, path, false)
			after, _ := os.ReadFile(path)
			if requests != 1 || string(before) != string(after) {
				t.Fatal("readback changed local native bytes")
			}
			generation, _ := codex.CurrentAuthGeneration()
			known, err := codex.IsCanonicalAuthGeneration(generation)
			if err != nil || known != matching || result.Deferred == matching {
				t.Fatalf("result=%+v known=%v err=%v", result, known, err)
			}
		})
	}
}

func TestUnknownUploadAdoptsOnlyVerifiedNewerHead(t *testing.T) {
	for _, scenario := range []string{"newer", "equal", "older", "unverified", "wrong_engine", "wrong_account", "unbound_account", "rotated", "deleted", "logout", "interrupted"} {
		t.Run(scenario, func(t *testing.T) {
			if scenario == "interrupted" && os.Geteuid() == 0 {
				t.Skip("directory permissions do not bind root")
			}
			calls := 0
			var path string
			var expected []byte
			client, authPath := sessionAuthClient(t, false, func(w http.ResponseWriter, r *http.Request) {
				calls++
				var request map[string]any
				_ = json.NewDecoder(r.Body).Decode(&request)
				if request["command"] != "retrieve" {
					t.Error("replayed an unknown upload")
				}
				payload, verified, engine, account := sessionAuthNew, "verified", "codex", 1
				switch scenario {
				case "equal":
					payload = strings.Replace(sessionAuthOld, `"old"`, `"different"`, 1)
				case "older":
					payload = strings.Replace(sessionAuthNew, "11:00:00", "09:00:00", 1)
				case "unverified":
					verified = "pending"
				case "wrong_engine":
					engine = "claude"
				case "wrong_account":
					account = 99
				case "rotated":
					_ = os.WriteFile(path, []byte(sessionAuthNative), 0600)
				case "deleted":
					_ = os.Remove(path)
				case "interrupted":
					// The adoption itself cannot finish: the credential directory stops
					// accepting the atomic replacement. Nothing is lost, nothing is
					// uploaded, and the result stays unresolved so the marker is kept.
					dir := filepath.Dir(path)
					_ = os.Chmod(dir, 0o500)
					t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
				case "logout":
					generation, _ := codex.CurrentAuthGeneration()
					_, err := codex.MarkLogoutIntent(generation)
					if err != nil {
						t.Error(err)
					}
				}
				expected, _ = os.ReadFile(path)
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "outdated", "engine": engine, "account_id": account, "verification_state": verified, "auth": json.RawMessage(payload)})
			})
			path = authPath
			client.Pool = accountpool.Load("codex", path, client.BaseURL)
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
				if result.Error != nil || result.Deferred || !result.Adopted || !result.AuthSynced || string(after) != sessionAuthNew {
					t.Fatalf("newer head not adopted: %+v", result)
				}
				generation, _ := codex.CurrentAuthGeneration()
				if result.Generation != generation.Digest {
					t.Fatal("reported wrong generation")
				}
			} else if !result.Deferred || result.Adopted || string(after) != string(expected) {
				t.Fatalf("unsafe recovery %s: %+v", scenario, result)
			}
		})
	}
}

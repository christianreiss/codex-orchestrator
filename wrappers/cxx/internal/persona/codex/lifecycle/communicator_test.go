package lifecycle

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"

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
					payload = sessionAuthNew
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "outdated", "engine": "codex", "verification_state": "verified", "auth": json.RawMessage(payload)})
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

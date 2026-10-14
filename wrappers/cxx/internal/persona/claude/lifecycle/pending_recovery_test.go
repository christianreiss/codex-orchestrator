package lifecycle

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
)

func TestSameVerifiedPairAcknowledgesLegacyDigestWithoutReplay(t *testing.T) {
	path, _ := sessionFixture(t)
	local, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	client := sessionClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in["command"] != "retrieve" {
			t.Error("unknown upload replayed")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "outdated", "engine": "claude", "verification_state": "verified", "digest": strings.Repeat("b", 64), "auth": json.RawMessage(local)})
	})
	result := reconcileUnknownAuth(context.Background(), client, path, true)
	if result.Error != nil || result.Deferred || !result.Uploaded || calls != 1 {
		t.Fatalf("legacy verified readback stayed wedged: %+v requests=%d", result, calls)
	}
	current, err := claude.ReadAuthSnapshot(false)
	if err != nil || current.ServerDigest != strings.Repeat("b", 64) || string(current.Raw) != string(local) {
		t.Fatalf("local bytes or server digest changed incorrectly: %v", err)
	}
}

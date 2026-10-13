package lifecycle

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

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
		canonicalSessionResponse(w, local, "verified")
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

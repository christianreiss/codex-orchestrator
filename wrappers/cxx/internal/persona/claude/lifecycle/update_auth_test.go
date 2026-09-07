package lifecycle

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestUpdateGuardRetriesPendingCredentialsWithoutMaterializingRemote(t *testing.T) {
	path, remote := sessionFixture(t)
	native := sessionPayload("pending", time.Now())
	_ = os.WriteFile(path, native, 0o600)
	var calls atomic.Int32
	client := sessionClient(t, func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		if body["command"] != "store" {
			t.Error("update guard downloaded credentials")
		}
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		// Definitively rejected candidate permits a verified canonical winner,
		// but the maintenance guard must not materialize that remote secret.
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "outdated", "verification_state": "verified", "candidate_rejected_definitive": true, "auth": remote, "canonical_digest": strings.Repeat("b", 64), "canonical_last_refresh": time.Now().UTC().Format(time.RFC3339Nano)})
	})
	if err := UploadPendingAuthBeforeUpdate(context.Background(), client, nil); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("retry calls=%d", calls.Load())
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != string(native) {
		t.Fatal("update guard overwrote native credentials")
	}
}

func TestUpdateGuardFailureRetainsPendingGeneration(t *testing.T) {
	path, _ := sessionFixture(t)
	native := sessionPayload("pending", time.Now())
	_ = os.WriteFile(path, native, 0o600)
	var calls atomic.Int32
	client := sessionClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	if err := UploadPendingAuthBeforeUpdate(context.Background(), client, nil); err == nil {
		t.Fatal("failed auth propagation allowed update")
	}
	if calls.Load() != 6 {
		t.Fatalf("bounded HTTP attempts=%d", calls.Load())
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != string(native) {
		t.Fatal("failed update discarded pending native credentials")
	}
}

func TestUpdateGuardAcknowledgesAcceptedCandidateWithoutRepeatingUpload(t *testing.T) {
	path, _ := sessionFixture(t)
	_ = os.WriteFile(path, sessionPayload("pending", time.Now()), 0o600)
	var calls atomic.Int32
	client := sessionClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = fmt.Fprintf(w, `{"status":"updated","verification_state":"verified","canonical_digest":%q}`, strings.Repeat("c", 64))
	})
	for range 2 {
		if err := UploadPendingAuthBeforeUpdate(context.Background(), client, nil); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("accepted candidate reuploaded %d times", calls.Load())
	}
}

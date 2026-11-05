package communicator

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestUnattendedHeaderOnlyUnderMarkedContext(t *testing.T) {
	h := http.Header{}
	SetUnattendedHeader(context.Background(), h)
	if h.Get(UnattendedHeader) != "" {
		t.Fatalf("attended request marked unattended")
	}
	SetUnattendedHeader(WithUnattended(context.Background()), h)
	if h.Get(UnattendedHeader) != "1" {
		t.Fatalf("unattended marker missing: %v", h)
	}
}

// The scheduler's flag must survive the hop to the worker process.
func TestUnattendedSyncRequestReachesWorker(t *testing.T) {
	raw, _ := json.Marshal(SyncRequest{Operation: "auth", Unattended: true, Scheduled: true})
	var got SyncRequest
	if err := json.Unmarshal(raw, &got); err != nil || !got.Unattended || got.Scheduled {
		t.Fatalf("round trip = %+v, %v", got, err)
	}
}

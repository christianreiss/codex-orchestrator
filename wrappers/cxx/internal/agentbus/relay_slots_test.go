package agentbus

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// slotRelay answers claim number `deliverOn` with a presence notice and parks
// every other claim until its request ends.
func slotRelay(deliverOn int32) (*relayClient, *atomic.Int32, *atomic.Int32) {
	var inFlight, claims atomic.Int32
	client := &relayClient{
		id: "11111111-1111-4111-8111-111111111111", token: "relay-token", baseURL: "https://relay.invalid",
		heartbeatEvery: time.Hour,
	}
	ok := func(body string) *http.Response {
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
	}
	client.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if !strings.HasSuffix(req.URL.Path, "/deliveries/claim") {
			return ok(`{}`), nil
		}
		if claims.Add(1) == deliverOn {
			return ok(`{"delivery":{"kind":"presence_notice","message_id":"m1","claim_id":"c1"}}`), nil
		}
		inFlight.Add(1)
		defer inFlight.Add(-1)
		<-req.Context().Done()
		return nil, req.Context().Err()
	})}
	return client, &inFlight, &claims
}

func waitRelay(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.After(time.Second)
	for !cond() {
		select {
		case <-deadline:
			t.Fatal(what)
		case <-time.After(2 * time.Millisecond):
		}
	}
}

func runRelay(t *testing.T, client *relayClient) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.pollParallel(ctx, nil, io.Discard, 8) }()
	return func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("relay poll did not stop")
		}
	}
}

func TestIdleDaemonRelayHoldsOneClaim(t *testing.T) {
	client, inFlight, _ := slotRelay(0)
	stop := runRelay(t, client)
	defer stop()
	waitRelay(t, "first claim never started", func() bool { return inFlight.Load() == 1 })
	time.Sleep(30 * time.Millisecond)
	if got := inFlight.Load(); got != 1 {
		t.Fatalf("idle relay holds %d parallel claims, want 1", got)
	}
}

func TestDeliveryOpensOneBurstSlot(t *testing.T) {
	client, inFlight, _ := slotRelay(1)
	stop := runRelay(t, client)
	defer stop()
	// The primary claimed the notice and opened a burst slot; both now wait.
	waitRelay(t, "no burst slot after a delivery", func() bool { return inFlight.Load() == 2 })
	time.Sleep(30 * time.Millisecond)
	if got := inFlight.Load(); got != 2 {
		t.Fatalf("after one delivery %d claims wait, want 2", got)
	}
}

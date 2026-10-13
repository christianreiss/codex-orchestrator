package communicator

import (
	"context"
	"testing"
	"time"
)

// Direct HTTPS refuses in milliseconds during an outage. A shared connection
// that is known to be down must not make each of a command's calls wait the
// full connect budget, or one managed launch costs minutes and its auth worker
// is killed mid-flight.
func TestWaitConnectionFailsFastDuringAnEstablishedOutage(t *testing.T) {
	s := &server{failures: 2}
	started := time.Now()
	if c := s.waitConnection(context.Background()); c != nil {
		t.Fatal("no connection exists")
	}
	if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
		t.Fatalf("an established outage must be reported at once, took %s", elapsed)
	}
}

func TestWaitConnectionRidesOutASingleBlip(t *testing.T) {
	s := &server{failures: 1}
	want := &connection{}
	go func() {
		time.Sleep(400 * time.Millisecond)
		s.mu.Lock()
		s.conn = want
		s.mu.Unlock()
	}()
	if got := s.waitConnection(context.Background()); got != want {
		t.Fatal("a reconnect inside the blip window was not awaited")
	}
}

func TestWaitConnectionStillWaitsForTheFirstConnection(t *testing.T) {
	s := &server{}
	want := &connection{}
	go func() {
		time.Sleep(300 * time.Millisecond)
		s.mu.Lock()
		s.conn = want
		s.mu.Unlock()
	}()
	started := time.Now()
	if got := s.waitConnection(context.Background()); got != want {
		t.Fatal("did not return the connection that arrived during the wait")
	}
	if time.Since(started) < 250*time.Millisecond {
		t.Fatal("returned before the connection existed")
	}
}

func TestWaitConnectionHonoursCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	s := &server{}
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	started := time.Now()
	if c := s.waitConnection(ctx); c != nil || time.Since(started) > 2*time.Second {
		t.Fatalf("cancellation ignored (%v)", time.Since(started))
	}
}

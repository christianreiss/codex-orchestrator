package communicator

import (
	"context"
	"testing"
	"time"
)

// fakeLoop plays connectLoop's half of the attempt protocol for waitConnection.
func fakeLoop(s *server, takes time.Duration, succeed bool, want *connection) {
	go func() {
		for range s.kick {
			s.beginAttempt()
			time.Sleep(takes)
			s.mu.Lock()
			s.attempting = false
			s.lastAttemptEnd = time.Now()
			if succeed {
				s.conn, s.failures = want, 0
			} else {
				s.failures++
			}
			s.mu.Unlock()
		}
	}()
}

func newTestServer(failures int, lastEnd time.Time) *server {
	return &server{failures: failures, lastAttemptEnd: lastEnd, kick: make(chan struct{}, 1)}
}

// Direct HTTPS refuses in milliseconds during an outage. A shared connection
// that is known to be down must not make each of a command's calls wait the
// full connect budget, or one managed launch costs minutes and its auth worker
// is killed mid-flight.
func TestWaitConnectionReportsAnOutageAfterOneKickedAttempt(t *testing.T) {
	s := newTestServer(3, time.Now().Add(-time.Hour))
	fakeLoop(s, 50*time.Millisecond, false, nil)
	started := time.Now()
	if c := s.waitConnection(context.Background()); c != nil {
		t.Fatal("no connection exists")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("an established outage must be reported after one attempt, took %s", elapsed)
	}
}

// The reverse matters just as much: the first request after the server returns
// must not wait out the remaining reconnect backoff (up to 30 s) while failing.
func TestWaitConnectionReconnectsOnDemandWhenTheServerReturns(t *testing.T) {
	want := &connection{}
	s := newTestServer(5, time.Now().Add(-time.Hour))
	fakeLoop(s, 50*time.Millisecond, true, want)
	started := time.Now()
	if got := s.waitConnection(context.Background()); got != want {
		t.Fatal("the on-demand reconnect was not used")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("on-demand reconnect took %s", elapsed)
	}
}

func TestWaitConnectionDoesNotHammerAfterAFreshFailure(t *testing.T) {
	s := newTestServer(4, time.Now())
	started := time.Now()
	if c := s.waitConnection(context.Background()); c != nil {
		t.Fatal("no connection exists")
	}
	if time.Since(started) > 200*time.Millisecond {
		t.Fatal("a failure from the last second must be reported at once")
	}
	select {
	case <-s.kick:
		t.Fatal("redialled although an attempt had just failed")
	default:
	}
}

func TestWaitConnectionRidesOutASingleBlipByRedialling(t *testing.T) {
	want := &connection{}
	s := newTestServer(1, time.Now())
	fakeLoop(s, 50*time.Millisecond, true, want)
	if got := s.waitConnection(context.Background()); got != want {
		t.Fatal("a dropped connection was not re-established for the waiting request")
	}
}

func TestWaitConnectionStillWaitsForTheFirstConnection(t *testing.T) {
	s := newTestServer(0, time.Time{})
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
	s := newTestServer(0, time.Time{})
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	started := time.Now()
	if c := s.waitConnection(ctx); c != nil || time.Since(started) > 2*time.Second {
		t.Fatalf("cancellation ignored (%v)", time.Since(started))
	}
}

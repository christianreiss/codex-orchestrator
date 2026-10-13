package communicator

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func serveUnderSupervision(t *testing.T, s *server, interval, idleAfter time.Duration) (cancel context.CancelFunc, served chan error) {
	t.Helper()
	dir, err := os.MkdirTemp("", "cc-idle-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	listener, err := net.Listen("unix", filepath.Join(dir, "s.sock"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	httpServer := &http.Server{Handler: http.NotFoundHandler()}
	s.supervise(ctx, cancel, httpServer, interval, idleAfter)
	served = make(chan error, 1)
	go func() { served <- httpServer.Serve(listener) }()
	return cancel, served
}

// An idle owner must actually exit. Cancelling the context alone left the HTTP
// server accepting on the socket with no connection loop behind it: every later
// managed call then failed against a zombie that no client would replace.
func TestIdleOwnerStopsServing(t *testing.T) {
	s := &server{lastUsed: time.Now().Add(-time.Hour), calls: map[string]*sharedCall{}}
	_, served := serveUnderSupervision(t, s, 10*time.Millisecond, 20*time.Millisecond)
	select {
	case err := <-served:
		if err != http.ErrServerClosed {
			t.Fatalf("unexpected serve result: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("idle owner is still serving: the socket would outlive its control connection")
	}
}

func TestBusyOwnerKeepsServing(t *testing.T) {
	s := &server{lastUsed: time.Now().Add(-time.Hour), leases: 1, calls: map[string]*sharedCall{}}
	_, served := serveUnderSupervision(t, s, 10*time.Millisecond, 20*time.Millisecond)
	select {
	case err := <-served:
		t.Fatalf("an owner holding a lease shut down: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestCancelledOwnerStopsServing(t *testing.T) {
	s := &server{lastUsed: time.Now(), leases: 1, calls: map[string]*sharedCall{}}
	cancel, served := serveUnderSupervision(t, s, time.Hour, time.Hour)
	cancel()
	select {
	case err := <-served:
		if err != http.ErrServerClosed {
			t.Fatalf("unexpected serve result: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a terminated owner kept serving")
	}
}

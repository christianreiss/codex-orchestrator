package communicator

import (
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

// controlServer is a stand-in for the orchestrator: it answers `hello` with a
// `ready` that does or does not announce remote control, and reports every other
// frame the owner sends back.
func controlServer(t *testing.T, announce bool) (*connection, chan frame) {
	t.Helper()
	got := make(chan frame, 8)
	c := testConnection(t, func(ws *websocket.Conn, f frame) {
		if f.Type == "hello" {
			ready := frame{Type: "ready", Protocol: Protocol}
			if announce {
				ready.Control = []string{controlTerminate}
			}
			_ = websocket.JSON.Send(ws, ready)
			return
		}
		got <- f
		if f.Type == "request_terminate" {
			_ = websocket.JSON.Send(ws, frame{Type: "terminate", RequestID: f.RequestID, Reason: f.Reason})
		}
	})
	return c, got
}

func next(t *testing.T, got chan frame, within time.Duration) (frame, bool) {
	t.Helper()
	select {
	case f := <-got:
		return f, true
	case <-time.After(within):
		return frame{}, false
	}
}

func TestOwnerDescribesItselfOnlyWhenServerAnnouncesControl(t *testing.T) {
	c, got := controlServer(t, true)
	c.onTerminate = func(string) {}
	if err := c.send(map[string]any{"type": "hello"}); err != nil {
		t.Fatal(err)
	}
	<-c.ready
	f, ok := next(t, got, 3*time.Second)
	if !ok || f.Type != "capabilities" {
		t.Fatalf("expected a capabilities frame, got %+v (received=%v)", f, ok)
	}

	silent, quiet := controlServer(t, false)
	silent.onTerminate = func(string) {}
	if err := silent.send(map[string]any{"type": "hello"}); err != nil {
		t.Fatal(err)
	}
	<-silent.ready
	if f, ok := next(t, quiet, 400*time.Millisecond); ok {
		t.Fatalf("an old server that announced nothing must hear nothing, got %+v", f)
	}
}

func TestTerminateIsAcknowledgedBeforeTheOwnerActs(t *testing.T) {
	c, got := controlServer(t, true)
	stopped := make(chan string, 1)
	c.onTerminate = func(reason string) { stopped <- reason }
	if err := c.send(map[string]any{"type": "hello"}); err != nil {
		t.Fatal(err)
	}
	<-c.ready
	if f, ok := next(t, got, 3*time.Second); !ok || f.Type != "capabilities" {
		t.Fatalf("capabilities first: %+v", f)
	}
	if err := c.send(map[string]any{"type": "request_terminate", "request_id": "r-1", "reason": "admin"}); err != nil {
		t.Fatal(err)
	}
	if f, ok := next(t, got, 3*time.Second); !ok || f.Type != "request_terminate" {
		t.Fatalf("test relay: %+v", f)
	}
	f, ok := next(t, got, 3*time.Second)
	if !ok || f.Type != "terminate_ack" || f.RequestID != "r-1" {
		t.Fatalf("expected terminate_ack for r-1, got %+v (received=%v)", f, ok)
	}
	select {
	case reason := <-stopped:
		if reason != "admin" {
			t.Fatalf("reason = %q", reason)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("owner never acted on an acknowledged terminate")
	}
}

func TestTerminateWithoutAnnouncementIsNotAnInstruction(t *testing.T) {
	c, got := controlServer(t, false)
	var acted atomic.Bool
	c.onTerminate = func(string) { acted.Store(true) }
	if err := c.send(map[string]any{"type": "hello"}); err != nil {
		t.Fatal(err)
	}
	<-c.ready
	if err := c.send(map[string]any{"type": "request_terminate", "request_id": "r-2"}); err != nil {
		t.Fatal(err)
	}
	if f, _ := next(t, got, 3*time.Second); f.Type != "request_terminate" {
		t.Fatalf("test relay: %+v", f)
	}
	if f, ok := next(t, got, 400*time.Millisecond); ok {
		t.Fatalf("an unannounced terminate was answered: %+v", f)
	}
	if acted.Load() {
		t.Fatal("an unannounced terminate stopped the owner")
	}
}

func TestOwnerThatCannotStopSaysSo(t *testing.T) {
	c, got := controlServer(t, true)
	// No onTerminate: the owner has nothing to stop with.
	if err := c.send(map[string]any{"type": "hello"}); err != nil {
		t.Fatal(err)
	}
	<-c.ready
	if f, ok := next(t, got, 3*time.Second); !ok || f.Type != "capabilities" {
		t.Fatalf("capabilities first: %+v", f)
	}
	_ = c.send(map[string]any{"type": "request_terminate", "request_id": "r-3"})
	_, _ = next(t, got, 3*time.Second)
	f, ok := next(t, got, 3*time.Second)
	if !ok || f.Type != "terminate_ack" || f.RequestID != "r-3" {
		t.Fatalf("expected a refusal for r-3, got %+v", f)
	}
}

func TestServerTerminateDrainsInFlightWorkThenStops(t *testing.T) {
	old := terminateDrain
	terminateDrain = 2 * time.Second
	t.Cleanup(func() { terminateDrain = old })
	var stopped atomic.Bool
	s := &server{stop: func() { stopped.Store(true) }, active: 1, calls: map[string]*sharedCall{}}
	s.terminate("test")
	s.terminate("again") // single-shot
	time.Sleep(300 * time.Millisecond)
	if stopped.Load() {
		t.Fatal("stopped while a request was still in flight")
	}
	s.mu.Lock()
	s.active = 0
	s.mu.Unlock()
	deadline := time.Now().Add(2 * time.Second)
	for !stopped.Load() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !stopped.Load() {
		t.Fatal("did not stop once the owner was quiet")
	}
}

func TestServerTerminateStopsAfterTheDrainBoundEvenIfBusy(t *testing.T) {
	old := terminateDrain
	terminateDrain = 200 * time.Millisecond
	t.Cleanup(func() { terminateDrain = old })
	var stopped atomic.Bool
	s := &server{stop: func() { stopped.Store(true) }, active: 3, calls: map[string]*sharedCall{}}
	s.terminate("busy")
	deadline := time.Now().Add(2 * time.Second)
	for !stopped.Load() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !stopped.Load() {
		t.Fatal("a busy owner must still stop after the drain bound")
	}
}

func TestServerTerminateWithoutAStopFuncIsHarmless(t *testing.T) {
	s := &server{calls: map[string]*sharedCall{}}
	s.terminate("nothing to stop")
}

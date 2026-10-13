package communicator

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

// controlServer is a stand-in for the orchestrator: it answers `hello` with a
// `ready` that does or does not announce remote control, and reports every other
// frame the owner sends back. A `request_terminate` frame from the test is turned
// into the `terminate` the real server would send, aimed at `target`.
func controlServer(t *testing.T, announce bool, target func() string) (*connection, chan frame) {
	t.Helper()
	got := make(chan frame, 16)
	c := testConnection(t, func(ws *websocket.Conn, f frame) {
		if f.Type == "hello" {
			ready := frame{Type: "ready", Protocol: Protocol}
			if announce {
				ready.Control = []string{controlTerminate, controlOwnerIdentity}
			}
			_ = websocket.JSON.Send(ws, ready)
			return
		}
		got <- f
		if f.Type == "request_terminate" {
			_ = websocket.JSON.Send(ws, frame{Type: "terminate", RequestID: f.RequestID, Reason: f.Reason, OwnerInstanceID: target()})
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

func handshake(t *testing.T, c *connection, got chan frame, expectCapabilities bool) {
	t.Helper()
	if err := c.send(map[string]any{"type": "hello"}); err != nil {
		t.Fatal(err)
	}
	<-c.ready
	if expectCapabilities {
		if f, ok := next(t, got, 3*time.Second); !ok || f.Type != "capabilities" {
			t.Fatalf("capabilities first: %+v", f)
		}
	}
}

func own() string   { return processInstance }
func other() string { return "11111111-2222-4333-8444-555555555555" }

func TestOwnerDescribesItselfOnlyWhenServerAnnouncesControl(t *testing.T) {
	c, got := controlServer(t, true, own)
	c.onTerminate = func(string, <-chan struct{}) {}
	handshake(t, c, got, true)

	silent, quiet := controlServer(t, false, own)
	silent.onTerminate = func(string, <-chan struct{}) {}
	handshake(t, silent, quiet, false)
	if f, ok := next(t, quiet, 400*time.Millisecond); ok {
		t.Fatalf("an old server that announced nothing must hear nothing, got %+v", f)
	}
}

func TestTerminateNamingThisOwnerIsAcknowledgedAndActedOn(t *testing.T) {
	c, got := controlServer(t, true, own)
	stopped := make(chan string, 1)
	c.onTerminate = func(reason string, acked <-chan struct{}) { stopped <- reason }
	handshake(t, c, got, true)
	_ = c.send(map[string]any{"type": "request_terminate", "request_id": "r-1", "reason": "admin"})
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

func TestTerminateAimedAtAnotherOwnerStopsNothing(t *testing.T) {
	for name, target := range map[string]func() string{"another process": other, "no owner named": func() string { return "" }} {
		t.Run(name, func(t *testing.T) {
			c, got := controlServer(t, true, target)
			var acted atomic.Bool
			c.onTerminate = func(string, <-chan struct{}) { acted.Store(true) }
			handshake(t, c, got, true)
			_ = c.send(map[string]any{"type": "request_terminate", "request_id": "r-x"})
			_, _ = next(t, got, 3*time.Second)
			f, ok := next(t, got, 3*time.Second)
			if !ok || f.Type != "terminate_ack" || f.RequestID != "r-x" {
				t.Fatalf("expected a refusal for r-x, got %+v", f)
			}
			time.Sleep(200 * time.Millisecond)
			if acted.Load() {
				t.Fatal("a command for another owner stopped this one")
			}
		})
	}
}

func TestDuplicateTerminateIsAnsweredTwiceAndStopsOnce(t *testing.T) {
	c, got := controlServer(t, true, own)
	var stops atomic.Int32
	c.onTerminate = func(string, <-chan struct{}) { stops.Add(1) }
	handshake(t, c, got, true)
	for i := 0; i < 2; i++ {
		_ = c.send(map[string]any{"type": "request_terminate", "request_id": "dup"})
	}
	acks := 0
	deadline := time.After(3 * time.Second)
	for acks < 2 {
		select {
		case f := <-got:
			if f.Type == "terminate_ack" && f.RequestID == "dup" {
				acks++
			}
		case <-deadline:
			t.Fatalf("only %d acknowledgements", acks)
		}
	}
	time.Sleep(200 * time.Millisecond)
	if stops.Load() != 1 {
		t.Fatalf("a repeated request id stopped the owner %d times", stops.Load())
	}
}

func TestTerminateWithoutAnnouncementIsNotAnInstruction(t *testing.T) {
	c, got := controlServer(t, false, own)
	var acted atomic.Bool
	c.onTerminate = func(string, <-chan struct{}) { acted.Store(true) }
	handshake(t, c, got, false)
	_ = c.send(map[string]any{"type": "request_terminate", "request_id": "r-2"})
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
	c, got := controlServer(t, true, own)
	// No onTerminate: the owner has nothing to stop with.
	handshake(t, c, got, true)
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
	s.terminate("test", nil)
	s.terminate("again", nil) // single-shot
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
	s.terminate("busy", nil)
	deadline := time.Now().Add(2 * time.Second)
	for !stopped.Load() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !stopped.Load() {
		t.Fatal("a busy owner must still stop after the drain bound")
	}
}

// An acknowledgement the server never reads must not keep an owner that has
// accepted a stop alive: shutdown is bounded by the drain, not by the write.
func TestStopDoesNotWaitForAnAcknowledgementThatCannotBeWritten(t *testing.T) {
	old := terminateDrain
	terminateDrain = 300 * time.Millisecond
	t.Cleanup(func() { terminateDrain = old })
	var stopped atomic.Bool
	s := &server{stop: func() { stopped.Store(true) }, calls: map[string]*sharedCall{}}
	never := make(chan struct{}) // the acknowledgement is never written
	started := time.Now()
	s.terminate("stuck ack", never)
	for !stopped.Load() && time.Since(started) < 3*time.Second {
		time.Sleep(10 * time.Millisecond)
	}
	if !stopped.Load() {
		t.Fatal("a stuck acknowledgement held the owner up")
	}
	if took := time.Since(started); took > 1500*time.Millisecond {
		t.Fatalf("stopping took %s with a 300 ms drain", took)
	}
}

func TestAcknowledgementWriteIsBoundedWhenTheWriterIsBusy(t *testing.T) {
	old := ackWriteBound
	ackWriteBound = 150 * time.Millisecond
	t.Cleanup(func() { ackWriteBound = old })
	c, got := controlServer(t, true, own)
	handshake(t, c, got, true)
	c.sendMu.Lock() // another send is stuck writing
	started := time.Now()
	err := c.sendWithin(map[string]any{"type": "terminate_ack"}, ackWriteBound)
	c.sendMu.Unlock()
	if err == nil {
		t.Fatal("a write behind a stuck writer must report that it was not written")
	}
	if took := time.Since(started); took > time.Second {
		t.Fatalf("bounded write took %s", took)
	}
}

func TestServerTerminateWithoutAStopFuncIsHarmless(t *testing.T) {
	s := &server{calls: map[string]*sharedCall{}}
	s.terminate("nothing to stop", nil)
	if s.draining.Load() {
		t.Fatal("an owner that cannot stop must not start refusing work")
	}
}

func TestStoppingOwnerAdmitsNoNewWorkButStillReportsStatus(t *testing.T) {
	s := &server{stop: func() {}, calls: map[string]*sharedCall{}, version: "test"}
	s.draining.Store(true)
	for _, path := range []string{"/host/agent-sessions", "/_comm/lease", "/_comm/sync", "/mcp", "/_comm/daemon"} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, nil))
		if w.Code != 503 {
			t.Fatalf("%s admitted while stopping: %d", path, w.Code)
		}
		if body := w.Body.String(); !contains(body, "communicator_unavailable") {
			t.Fatalf("%s: a definitive not-sent 503 was expected, got %s", path, body)
		}
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/_comm/status", nil))
	if w.Code != 200 {
		t.Fatalf("status must stay readable while stopping: %d", w.Code)
	}
}

func contains(haystack, needle string) bool { return strings.Contains(haystack, needle) }

func TestRuntimeIdentityIsStablePerSocketAndDistinctAcrossRoots(t *testing.T) {
	a := runtimeIdentity("/run/user/1000/cxx-comm-abc/control.sock")
	if a != runtimeIdentity("/run/user/1000/cxx-comm-abc/control.sock") {
		t.Fatal("the same socket must name the same runtime")
	}
	if a == runtimeIdentity("/tmp/custom-root/cxx-comm-abc/control.sock") {
		t.Fatal("distinct runtime roots must not share an identity")
	}
	if len(a) != 16 {
		t.Fatalf("runtime id %q", a)
	}
	if processInstance == "" || len(processInstance) != 36 {
		t.Fatalf("instance id %q", processInstance)
	}
}

// A server that announces "terminate" but not "owner_identity" predates owner
// identity. Its capabilities schema rejects fields it does not know, and it cannot
// aim a stop at one process, so the owner sends it only the legacy fields, says it
// cannot be stopped remotely, and ignores a terminate frame from it.
func TestOwnerNeverSendsIdentityToAServerThatDidNotAnnounceIt(t *testing.T) {
	type legacyCapabilities struct {
		Type      string `json:"type"`
		Terminate bool   `json:"terminate"`
		PID       int    `json:"pid"`
		StartedAt string `json:"started_at"`
	}
	checked := make(chan error, 1)
	legacy := make(chan legacyCapabilities, 1)
	remote := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var hello map[string]any
		if err := websocket.JSON.Receive(ws, &hello); err != nil {
			checked <- err
			return
		}
		_ = websocket.JSON.Send(ws, map[string]any{"type": "ready", "protocol": 1, "control": []string{"terminate"}})
		var raw json.RawMessage
		if err := websocket.JSON.Receive(ws, &raw); err != nil {
			checked <- err
			return
		}
		var strict legacyCapabilities
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&strict); err != nil {
			checked <- err
			return
		}
		legacy <- strict
		// Even a well-formed command from this server is not an instruction.
		_ = websocket.JSON.Send(ws, map[string]any{"type": "terminate", "request_id": "legacy-1", "owner_instance_id": processInstance, "reason": "admin"})
		checked <- nil
		time.Sleep(300 * time.Millisecond)
	}))
	t.Cleanup(remote.Close)
	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: remote.URL, APIKey: "fixture"}}
	transport, err := directTransport(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer transport.CloseIdleConnections()
	ws, err := dial(context.Background(), cfg, transport)
	if err != nil {
		t.Fatal(err)
	}
	stopped := make(chan struct{}, 1)
	c := &connection{ws: ws, ready: make(chan struct{}), done: make(chan struct{}), pending: map[string]chan frame{}, runtimeID: "aaaaaaaaaaaaaaaa"}
	c.onTerminate = func(string, <-chan struct{}) { stopped <- struct{}{} }
	go c.receive()
	t.Cleanup(func() { ws.Close(); <-c.done })
	if err := c.send(map[string]any{"type": "hello", "protocol": 1, "username": "fixture", "version": "0.9.77"}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-checked:
		if err != nil {
			t.Fatalf("the owner sent a field the older server does not know: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the handshake with the older server did not complete")
	}
	if got := <-legacy; got.Type != "capabilities" || got.Terminate || got.PID != os.Getpid() {
		t.Fatalf("legacy capabilities must describe the process and claim no remote stop: %+v", got)
	}
	select {
	case <-stopped:
		t.Fatal("the owner obeyed a terminate frame from a server that cannot aim it")
	case <-time.After(500 * time.Millisecond):
	}
}

func TestOwnerIdentityRequiresServerAnnouncement(t *testing.T) {
	for _, modern := range []bool{false, true} {
		name := "legacy-terminate-only"
		if modern {
			name = "identity-enabled"
		}
		t.Run(name, func(t *testing.T) {
			got := make(chan map[string]any, 1)
			upstream := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
				defer ws.Close()
				controls := []string{"terminate"}
				if modern {
					controls = append(controls, controlOwnerIdentity)
				}
				websocket.JSON.Send(ws, map[string]any{"type": "ready", "protocol": 1, "control": controls})
				var caps map[string]any
				if websocket.JSON.Receive(ws, &caps) == nil {
					got <- caps
				}
			}))
			defer upstream.Close()
			ws, err := websocket.Dial("ws"+strings.TrimPrefix(upstream.URL, "http"), "", "http://fixture")
			if err != nil {
				t.Fatal(err)
			}
			defer ws.Close()
			c := &connection{ws: ws, ready: make(chan struct{}), done: make(chan struct{}), onTerminate: func(string) {}, runtimeID: "fixture-runtime"}
			go c.receive()
			select {
			case caps := <-got:
				_, instance := caps["instance_id"]
				_, runtime := caps["runtime_id"]
				if instance != modern || runtime != modern || caps["terminate"] != modern {
					t.Fatalf("identity fields violate negotiated shape: %v", caps)
				}
				if !modern && len(caps) != 4 {
					t.Fatalf("legacy strict capabilities schema would reject: %v", caps)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("owner did not describe its negotiated capabilities")
			}
		})
	}
}

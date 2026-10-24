package communicator

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

func stateTestSocket(t *testing.T, handle func(*websocket.Conn, StateFrame)) string {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "state.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var open StateFrame
		if websocket.JSON.Receive(ws, &open) != nil {
			return
		}
		handle(ws, open)
	})}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	return socket
}
func stateTestSnapshot(open StateFrame) StateFrame {
	return StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: uuid.NewString(), Revision: "1", Payload: json.RawMessage(`{"ownership_mode":"connection","authorization_deadline":null,"work_revision":"1"}`)}
}
func TestStateClientRejectsUnconfirmedOwnership(t *testing.T) {
	socket := stateTestSocket(t, func(ws *websocket.Conn, open StateFrame) {
		f := stateTestSnapshot(open)
		f.Payload = json.RawMessage(`{"ownership_mode":"lease"}`)
		websocket.JSON.Send(ws, f)
	})
	c, err := DialStateSocket(context.Background(), socket, "/state", StateScope{Topic: "session"}, StateAuth{})
	if err == nil {
		c.Close()
		t.Fatal("accepted lease snapshot as connection authority")
	}
}
func TestStateClientRevisionEpochAndDisconnect(t *testing.T) {
	send := make(chan StateFrame, 4)
	initial := make(chan StateFrame, 1)
	socket := stateTestSocket(t, func(ws *websocket.Conn, open StateFrame) {
		f := stateTestSnapshot(open)
		websocket.JSON.Send(ws, f)
		initial <- f
		for next := range send {
			if websocket.JSON.Send(ws, next) != nil {
				return
			}
		}
	})
	c, err := DialStateSocket(context.Background(), socket, "/state", StateScope{Topic: "session"}, StateAuth{})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	defer close(send)
	first := <-initial
	_, changed, live := c.Snapshot(nil)
	if !live {
		t.Fatal("snapshot not live")
	}
	replay := first
	replay.Type = "state_delta"
	send <- replay
	select {
	case <-changed:
		t.Fatal("same revision notified")
	case <-time.After(20 * time.Millisecond):
	}
	next := replay
	next.Revision = "2"
	send <- next
	select {
	case <-changed:
	case <-time.After(time.Second):
		t.Fatal("delta did not wake")
	}
	got, _, live := c.Snapshot(nil)
	if !live || got.Revision != "2" {
		t.Fatalf("snapshot %+v live=%v", got, live)
	}
	next.OwnerEpoch = uuid.NewString()
	next.Revision = "3"
	send <- next
	select {
	case <-c.Done():
	case <-time.After(time.Second):
		t.Fatal("epoch change did not fence attachment")
	}
	_, _, live = c.Snapshot(nil)
	if live {
		t.Fatal("disconnected stream retained authority")
	}
}
func TestStateFrameEnvelopeSurvivesCommunicatorDispatch(t *testing.T) {
	original := stateTestSnapshot(StateFrame{StreamID: uuid.NewString()})
	raw, _ := json.Marshal(original)
	var wire frame
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	wire.StateFrame.Type = wire.Type
	wire.StateFrame.Protocol = wire.Protocol
	wire.StateFrame.Revision = wire.Revision
	wire.StateFrame.Payload = wire.Payload
	if wire.StateFrame.StreamID != original.StreamID || wire.StateFrame.OwnerEpoch != original.OwnerEpoch || !validState(wire.StateFrame) {
		t.Fatalf("lost envelope: %+v", wire)
	}
}
func TestConnectionOwnedRejectsExpiredAuthorization(t *testing.T) {
	if connectionOwned(json.RawMessage(`{"ownership_mode":"connection","authorization_deadline":"2000-01-01T00:00:00Z"}`)) {
		t.Fatal("expired authority accepted")
	}
}

func TestStateDeadlineUsesServerClockAndDoesNotRenewOnRead(t *testing.T) {
	received := time.Now()
	raw := json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:00Z","authorization_deadline":"2000-01-01T00:00:30Z"}`)
	deadline, ok := stateDeadline(raw, received)
	if !ok || deadline.Sub(received) != 30*time.Second {
		t.Fatalf("deadline=%v valid=%v", deadline, ok)
	}
	c := &StateClient{live: true, snapshot: StateFrame{Payload: raw}, received: received, deadline: received.Add(-time.Second), changed: make(chan struct{})}
	_, _, live := c.Snapshot(nil)
	if live {
		t.Fatal("reading cached snapshot extended expired authority")
	}
}

func TestLocalStateLivenessUsesSharedTickAndConsumesPongs(t *testing.T) {
	now := time.Now()
	var stopped atomic.Int32
	c := &connection{stateLocalLiveness: true, states: map[string]*stateRelay{}}
	for i := 0; i < 200; i++ {
		c.states[uuid.NewString()] = &stateRelay{epoch: uuid.NewString(), events: make(chan StateFrame, 2), lastPong: now, stop: func() { stopped.Add(1) }}
	}
	c.pingLocalStates(now.Add(15 * time.Second))
	alive := ""
	for id, stream := range c.states {
		ping := <-stream.events
		if ping.Type != "state_ping" || ping.StreamID != id || ping.OwnerEpoch != stream.epoch {
			t.Fatal("invalid local ping")
		}
		if alive == "" {
			alive = id
			handled, valid := c.acceptLocalStatePong(StateFrame{StreamID: id, OwnerEpoch: stream.epoch}, now.Add(30*time.Second))
			if !handled || !valid {
				t.Fatal("local pong was not consumed")
			}
		}
	}
	c.pingLocalStates(now.Add(45 * time.Second))
	if stopped.Load() != 199 {
		t.Fatalf("stopped %d instead of only unresponsive local attachments", stopped.Load())
	}
	if c.states[alive].stopping {
		t.Fatal("responsive local attachment closed")
	}
	if handled, valid := c.acceptLocalStatePong(StateFrame{StreamID: alive, OwnerEpoch: uuid.NewString()}, now); !handled || valid {
		t.Fatal("accepted wrong epoch pong")
	}
	c.pingLocalStates(now.Add(60 * time.Second))
	if stopped.Load() != 199 {
		t.Fatal("repeated close for already stopped stream")
	}
}
func TestLocalStateLivenessRequiresServerAcceptance(t *testing.T) {
	now := time.Now()
	stream := &stateRelay{epoch: uuid.NewString(), events: make(chan StateFrame, 1), lastPong: now, stop: func() { t.Fatal("legacy stream stopped locally") }}
	c := &connection{stateLivenessOffered: true, states: map[string]*stateRelay{"stream": stream}}
	c.pingLocalStates(now.Add(time.Minute))
	if len(stream.events) != 0 {
		t.Fatal("local ping before server acceptance")
	}
	if handled, _ := c.acceptLocalStatePong(StateFrame{StreamID: "stream", OwnerEpoch: stream.epoch}, now); handled {
		t.Fatal("suppressed legacy upstream pong")
	}
}
func TestHungCommunicatorStillHasBoundedNativeReadDeadline(t *testing.T) {
	now := time.Now()
	if got := stateReadDeadline(now, time.Time{}); got.Sub(now) != 45*time.Second {
		t.Fatalf("hung broker deadline %s", got.Sub(now))
	}
	if got := stateReadDeadline(now, now.Add(7*time.Second)); got.Sub(now) != 7*time.Second {
		t.Fatal("transport timeout extended security deadline")
	}
}
func TestBrokerParentLossClosesAllLocalStateClients(t *testing.T) {
	var upstreamPongs atomic.Int32
	s, c := ownerWithConnection(t, func(ws *websocket.Conn, f frame) {
		if f.Type == "state_open" {
			open := f.StateFrame
			open.StreamID = f.StreamID
			websocket.JSON.Send(ws, stateTestSnapshot(open))
		}
		if f.Type == "state_pong" {
			upstreamPongs.Add(1)
		}
	})
	c.mu.Lock()
	c.stateEnabled = true
	c.stateLocalLiveness = true
	c.mu.Unlock()
	socket := filepath.Join(t.TempDir(), "broker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	local := &http.Server{Handler: s}
	go local.Serve(listener)
	defer local.Close()
	clients := []*StateClient{}
	for i := 0; i < 2; i++ {
		client, err := DialStateSocket(context.Background(), socket, "/_comm/state", StateScope{Topic: "session"}, StateAuth{})
		if err != nil {
			t.Fatal(err)
		}
		clients = append(clients, client)
		defer client.Close()
	}
	c.pingLocalStates(time.Now())
	// All local pongs stay inside the communicator; no server metadata refresh is needed.
	time.Sleep(20 * time.Millisecond)
	if upstreamPongs.Load() != 0 {
		t.Fatal("local pongs leaked onto upstream control connection")
	}
	c.ws.Close()
	<-c.done
	for _, client := range clients {
		select {
		case <-client.Done():
		case <-time.After(time.Second):
			t.Fatal("parent loss did not close local attachment")
		}
		if _, _, live := client.Snapshot(nil); live {
			t.Fatal("lost parent retained authority")
		}
	}
}
func TestStateLivenessNegotiationAwaitsServerAck(t *testing.T) {
	caps := make(chan frame, 1)
	c := testConnection(t, func(ws *websocket.Conn, f frame) {
		switch f.Type {
		case "hello":
			websocket.JSON.Send(ws, frame{Type: "ready", Protocol: Protocol, Control: []string{controlTerminate, controlOwnerIdentity, StateCapability, StateLivenessCapability}})
		case "capabilities":
			caps <- f
		case "test_accept":
			websocket.JSON.Send(ws, frame{Type: "state_liveness_ready", Protocol: Protocol})
		}
	})
	if err := c.send(map[string]any{"type": "hello"}); err != nil {
		t.Fatal(err)
	}
	select {
	case f := <-caps:
		if f.StateLiveness != "communicator" {
			t.Fatalf("capability missing: %+v", f)
		}
	case <-time.After(time.Second):
		t.Fatal("no capability announcement")
	}
	c.mu.Lock()
	active := c.stateLocalLiveness
	c.mu.Unlock()
	if active {
		t.Fatal("delegation active before server ACK")
	}
	c.send(map[string]any{"type": "test_accept"})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		active = c.stateLocalLiveness
		c.mu.Unlock()
		if active {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("server acceptance did not enable local liveness")
}

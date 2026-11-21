package communicator

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

// Shutdown must interrupt both the HTTP upgrade and the initial snapshot,
// before the established stream's cancellation watcher exists.
func TestStateHandshakeCancellation(t *testing.T) {
	for _, phase := range []string{"upgrade", "snapshot", "snapshot-race"} {
		t.Run(phase, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			defer close(release)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var socket string
			if phase == "upgrade" {
				socket = filepath.Join(t.TempDir(), "s")
				ln, err := net.Listen("unix", socket)
				if err != nil {
					t.Fatal(err)
				}
				srv := &http.Server{Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
					close(entered)
					<-release
				})}
				go srv.Serve(ln)
				defer srv.Close()
			} else {
				socket = stateTestSocket(t, func(ws *websocket.Conn, open StateFrame) {
					close(entered)
					if phase == "snapshot-race" {
						<-ctx.Done()
						_ = websocket.JSON.Send(ws, stateTestSnapshot(open))
					}
					<-release
				})
			}
			done := make(chan error, 1)
			go func() {
				client, err := DialStateSocket(ctx, socket, "/state", StateScope{Topic: "session"}, StateAuth{})
				if client != nil {
					client.Close()
				}
				done <- err
			}()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("handshake did not start")
			}
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancel error: %v", err)
				}
			case <-time.After(500 * time.Millisecond):
				t.Fatal("canceled handshake blocked shutdown")
			}
		})
	}
}

func TestRequestFrameOmitsStateStreamID(t *testing.T) {
	raw, err := json.Marshal(frame{Type: "request"})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if _, present := fields["stream_id"]; present {
		t.Fatalf("HTTP frame contains a state-stream field: %s", raw)
	}
	raw, err = json.Marshal(StateFrame{Type: "state_open", StreamID: "live-stream"})
	if err != nil {
		t.Fatal(err)
	}
	var roundtrip StateFrame
	if err := json.Unmarshal(raw, &roundtrip); err != nil || roundtrip.StreamID != "live-stream" {
		t.Fatalf("state stream lost its identity: %s, %v", raw, err)
	}
}

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
	if new(StateClient).setTiming(json.RawMessage(`{"ownership_mode":"connection","authorization_deadline":"2000-01-01T00:00:00Z"}`), time.Now(), false) {
		t.Fatal("expired authority accepted")
	}
}

func TestStateDeadlineUsesServerClockAndDoesNotRenewOnRead(t *testing.T) {
	received := time.Now()
	raw := json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:00Z","authorization_deadline":"2000-01-01T00:00:30Z"}`)
	var client StateClient
	ok := client.setTiming(raw, received, false)
	deadline := client.deadline
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

func TestAuthorizationRefreshValidation(t *testing.T) {
	const initial = `{"ownership_mode":"connection","server_time":"2000-01-01T00:00:00Z","authorization_deadline":"2000-01-01T00:00:10Z"}`
	const refresh = `{"ownership_mode":"connection","server_time":"2000-01-01T00:00:01Z","authorization_deadline":"2000-01-01T00:00:10Z"}`
	received := time.Now()
	for _, tc := range []struct {
		name, payload string
		after         time.Duration
	}{
		{"same_timestamp", initial, time.Second},
		{"expired_current", refresh, 10 * time.Second},
		{"expired_new", `{"ownership_mode":"connection","server_time":"2000-01-01T00:00:02Z","authorization_deadline":"2000-01-01T00:00:01Z"}`, time.Second},
		{"missing_deadline", `{"ownership_mode":"connection","server_time":"2000-01-01T00:00:01Z"}`, time.Second},
		{"unlimited", `{"ownership_mode":"connection","server_time":"2000-01-01T00:00:01Z","authorization_deadline":null}`, time.Second},
		{"missing_clock", `{"ownership_mode":"connection","authorization_deadline":null}`, time.Second},
		{"ownership", `{"ownership_mode":"lease","server_time":"2000-01-01T00:00:01Z","authorization_deadline":"2000-01-01T00:00:10Z"}`, time.Second},
		{"business_field", `{"ownership_mode":"connection","server_time":"2000-01-01T00:00:01Z","authorization_deadline":"2000-01-01T00:00:10Z","jobs":[]}`, time.Second},
		{"duplicate_field", `{"ownership_mode":"connection","server_time":"2000-01-01T00:00:01Z","authorization_deadline":"2000-01-01T00:00:10Z","authorization_deadline":"2000-01-01T00:00:10Z"}`, time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var client StateClient
			if !client.setTiming(json.RawMessage(initial), received, false) {
				t.Fatal("invalid fixture")
			}
			if client.setTiming(json.RawMessage(tc.payload), received.Add(tc.after), true) {
				t.Fatal("refresh accepted")
			}
		})
	}
	var client StateClient
	if !client.setTiming(json.RawMessage(initial), received, false) {
		t.Fatal("initial timing")
	}
	deadline := client.deadline
	if !client.setTiming(json.RawMessage(refresh), received.Add(4*time.Second), true) || !client.deadline.Equal(deadline) {
		t.Fatal("delayed refresh extended the same deadline")
	}
	if client.setTiming(json.RawMessage(refresh), received.Add(5*time.Second), true) {
		t.Fatal("accepted replay")
	}
	clearDeadline := json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:05Z","authorization_deadline":null}`)
	if !client.setTiming(clearDeadline, received.Add(5*time.Second), false) || !client.deadline.IsZero() {
		t.Fatal("secure authorization without deadline rejected")
	}
}

func TestAuthorizationRefreshThroughCommunicatorTransport(t *testing.T) {
	initial := make(chan StateFrame, 1)
	ownerWS := make(chan *websocket.Conn, 1)
	fromClient := make(chan string, 12)
	s, c := ownerWithConnection(t, func(ws *websocket.Conn, f frame) {
		fromClient <- f.Type
		if f.Type != "state_open" {
			return
		}
		if string(f.Payload) != string(refreshOption) {
			t.Error("IPC did not forward opt-in")
		}
		first := stateTestSnapshot(f.StateFrame)
		first.Payload = json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:00Z","authorization_deadline":"2000-01-01T00:00:01Z","work_revision":"job-1"}`)
		if websocket.JSON.Send(ws, first) != nil {
			return
		}
		initial <- first
		ownerWS <- ws
	})
	c.mu.Lock()
	c.stateEnabled = true
	c.mu.Unlock()
	socket := filepath.Join(t.TempDir(), "broker.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	local := &http.Server{Handler: s}
	go local.Serve(ln)
	defer local.Close()
	client, err := DialStateSocket(context.Background(), socket, "/_comm/state", StateScope{Topic: "session"}, StateAuth{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	first, ws := <-initial, <-ownerWS
	business, wake, live := client.Snapshot(nil)
	if !live {
		t.Fatal("missing initial authority")
	}
	original := client.AuthorizationDeadline()
	for _, want := range []string{"state_open", "state_ack"} {
		select {
		case got := <-fromClient:
			if got != want {
				t.Fatalf("got %s, want %s", got, want)
			}
		case <-time.After(time.Second):
			t.Fatal("initial acknowledgements missing")
		}
	}
	send := func(f StateFrame) {
		t.Helper()
		if err := websocket.JSON.Send(ws, f); err != nil {
			t.Fatal(err)
		}
	}
	refresh := first
	refresh.Type = "state_ping"
	refresh.Payload = json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:00.001Z","authorization_deadline":"2000-01-01T00:00:10Z"}`)
	send(refresh)
	// This liveness pong orders the preceding refresh through both transports.
	ping := refresh
	ping.Revision = ""
	ping.Payload = nil
	send(ping)
	select {
	case got := <-fromClient:
		if got != "state_pong" {
			t.Fatalf("unexpected refresh response %s", got)
		}
	case <-time.After(time.Second):
		t.Fatal("liveness pong missing")
	}
	if !client.AuthorizationDeadline().After(original) {
		t.Fatal("renewal missing")
	}
	select {
	case <-wake:
		t.Fatal("refresh woke business subscriber")
	case <-time.After(time.Until(original) + 20*time.Millisecond):
	}
	got, wake, live := client.Snapshot(nil)
	if !live || got.Revision != business.Revision || string(got.Payload) != string(business.Payload) {
		t.Fatal("renewal replaced business data or revoked authority at old deadline")
	}
	delta := first
	delta.Type = "state_delta"
	delta.Revision = "2"
	delta.Payload = json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:01.2Z","authorization_deadline":"2000-01-01T00:00:10Z","work_revision":"job-2"}`)
	send(delta)
	select {
	case <-wake:
	case <-time.After(time.Second):
		t.Fatal("business delta did not wake")
	}
	if got, _, live := client.Snapshot(nil); !live || got.Revision != "2" {
		t.Fatal("business delta missing")
	}
	refresh.Revision = delta.Revision
	refresh.Payload = json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:01.201Z","authorization_deadline":"2000-01-01T00:00:01.300Z"}`)
	send(refresh)
	select {
	case <-client.Done():
	case <-time.After(time.Second):
		t.Fatal("shortened deadline failed to close idle stream")
	}
	if _, _, live := client.Snapshot(nil); live {
		t.Fatal("revoked stream retained authority")
	}
}

func TestInvalidAuthorizationFrameDisconnects(t *testing.T) {
	for _, name := range []string{"stream", "epoch", "revision", "protocol", "missing_payload", "extra_scope", "replay", "expired"} {
		t.Run(name, func(t *testing.T) {
			allow := make(chan struct{})
			defer close(allow)
			trigger := make(chan struct{})
			socket := stateTestSocket(t, func(ws *websocket.Conn, open StateFrame) {
				f := stateTestSnapshot(open)
				f.Payload = json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:00Z","authorization_deadline":null}`)
				if websocket.JSON.Send(ws, f) != nil {
					return
				}
				<-trigger
				f.Type = "state_ping"
				f.Payload = json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:01Z","authorization_deadline":"2000-01-01T00:01:00Z"}`)
				switch name {
				case "stream":
					f.StreamID = uuid.NewString()
				case "epoch":
					f.OwnerEpoch = uuid.NewString()
				case "revision":
					f.Revision = "2"
				case "protocol":
					f.Protocol = 2
				case "missing_payload":
					f.Payload = nil
				case "extra_scope":
					f.Scope = &StateScope{Topic: "receiver"}
				case "replay":
					if websocket.JSON.Send(ws, f) != nil {
						return
					}
				case "expired":
					f.Payload = json.RawMessage(`{"ownership_mode":"connection","server_time":"2000-01-01T00:00:02Z","authorization_deadline":"2000-01-01T00:00:01Z"}`)
				}
				websocket.JSON.Send(ws, f)
				<-allow
			})
			c, err := DialStateSocket(context.Background(), socket, "/state", StateScope{Topic: "session"}, StateAuth{})
			close(trigger)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			select {
			case <-c.Done():
			case <-time.After(time.Second):
				t.Fatal("invalid authorization retained connection")
			}
			if _, _, live := c.Snapshot(nil); live {
				t.Fatal("retained authority")
			}
		})
	}
}

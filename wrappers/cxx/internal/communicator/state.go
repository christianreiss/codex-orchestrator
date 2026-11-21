package communicator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

const StateCapability = "control_state_v1"
const StateLivenessCapability = "communicator_state_liveness_v1"
const stateTransportTimeout = 45 * time.Second

// StateScope names the exact authority observed by a live attachment.
type StateScope struct {
	ReceiverGeneration string `json:"receiver_generation,omitempty"`
	Topic              string `json:"topic"`
	ProviderSessionID  string `json:"provider_session_id,omitempty"`
	Engine             string `json:"engine,omitempty"`
	SessionID          string `json:"session_id,omitempty"`
	RelayID            string `json:"relay_id,omitempty"`
	BindingGeneration  int    `json:"binding_generation,omitempty"`
	NativeInstanceID   string `json:"native_instance_id,omitempty"`
}
type StateAuth struct {
	BridgeToken string `json:"bridge_token,omitempty"`
	RelayToken  string `json:"relay_token,omitempty"`
}
type StateFrame struct {
	Type       string          `json:"type"`
	Protocol   int             `json:"protocol"`
	StreamID   string          `json:"stream_id,omitempty"`
	OwnerEpoch string          `json:"owner_epoch,omitempty"`
	Revision   string          `json:"revision,omitempty"`
	Scope      *StateScope     `json:"scope,omitempty"`
	Auth       *StateAuth      `json:"auth,omitempty"`
	CommandID  string          `json:"command_id,omitempty"`
	Payload    json.RawMessage `json:"payload,omitempty"`
	Code       string          `json:"code,omitempty"`
}

// StateClient validates the epoch/revision boundary before exposing state.
// It never falls back to polling after accepting a connection-owned snapshot.
type StateClient struct {
	ws             *websocket.Conn
	sendMu         sync.Mutex
	mu             sync.Mutex
	snapshot       StateFrame
	subscription   StateSubscription
	serverTime     time.Time
	lastServerTime time.Time
	received       time.Time
	deadline       time.Time
	live           bool
	changed        chan struct{}
	done           chan struct{}
	cancel         context.CancelFunc
}

// StateSubscription negotiates authority-only updates per stream. A broker
// forwards accepted frames in wire order while keeping its client's credentials local.
type StateSubscription struct {
	AuthorizationRefresh bool
	Forward              func(StateFrame) error
}

var refreshOption = json.RawMessage(`{"authorization_refresh":1}`)

func (f StateFrame) RequestsAuthorizationRefresh() bool {
	var options map[string]any
	return json.Unmarshal(f.Payload, &options) == nil && options["authorization_refresh"] == float64(1)
}

func DialState(ctx context.Context, base string, scope StateScope, auth StateAuth) (*StateClient, error) {
	return (StateSubscription{AuthorizationRefresh: true}).Dial(ctx, base, scope, auth)
}

func (sub StateSubscription) Dial(ctx context.Context, base string, scope StateScope, auth StateAuth) (*StateClient, error) {
	ep := endpointFor(base)
	if ep == nil || ep.transportDisabled() {
		return nil, errors.New("control state requires communicator")
	}
	if err := ep.ensure(ctx); err != nil {
		return nil, err
	}
	ep.once.Do(func() { go ep.lease(processContext) })
	return sub.DialSocket(ctx, ep.localSocket(), "/_comm/state", scope, auth)
}

// DialStateSocket is also used by the credential-free per-launch broker client.
func DialStateSocket(ctx context.Context, socket, path string, scope StateScope, auth StateAuth) (*StateClient, error) {
	return (StateSubscription{AuthorizationRefresh: true}).DialSocket(ctx, socket, path, scope, auth)
}

func (sub StateSubscription) DialSocket(ctx context.Context, socket, path string, scope StateScope, auth StateAuth) (client *StateClient, err error) {
	raw, err := (&net.Dialer{}).DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, err
	}
	// DialContext covers only connect. Keep cancellation effective through the
	// HTTP upgrade, first snapshot and ack, until the live stream takes over.
	stopHandshakeCancel := context.AfterFunc(ctx, func() { _ = raw.Close() })
	defer stopHandshakeCancel()
	defer func() {
		if err != nil && ctx.Err() != nil {
			err = ctx.Err()
		}
	}()
	raw.SetDeadline(time.Now().Add(15 * time.Second))
	cfg, err := websocket.NewConfig("ws://communicator.local"+path, "http://communicator.local")
	if err != nil {
		raw.Close()
		return nil, err
	}
	ws, err := websocket.NewClient(cfg, raw)
	if err != nil {
		raw.Close()
		return nil, err
	}
	ws.MaxPayloadBytes = maxFrameBody
	child, cancel := context.WithCancel(ctx)
	c := &StateClient{ws: ws, subscription: sub, changed: make(chan struct{}), done: make(chan struct{}), cancel: cancel}
	open := StateFrame{Type: "state_open", Protocol: 1, StreamID: uuid.NewString(), Scope: &scope, Auth: &auth}
	if sub.AuthorizationRefresh {
		open.Payload = refreshOption
	}
	if err = c.send(open); err != nil {
		ws.Close()
		cancel()
		return nil, err
	}
	var first StateFrame
	if err = websocket.JSON.Receive(ws, &first); err != nil {
		ws.Close()
		cancel()
		return nil, err
	}
	if first.StreamID != open.StreamID || first.Type != "state_snapshot" || !validState(first) || !c.setTiming(first.Payload, time.Now(), false) {
		ws.Close()
		cancel()
		return nil, errors.New("authenticated connection-owned snapshot required")
	}
	c.snapshot = first
	if sub.Forward != nil {
		if err = sub.Forward(first); err != nil {
			ws.Close()
			cancel()
			return nil, err
		}
	}
	c.live = true
	raw.SetDeadline(time.Time{})
	if err = c.send(StateFrame{Type: "state_ack", Protocol: 1, StreamID: first.StreamID, OwnerEpoch: first.OwnerEpoch, Revision: first.Revision}); err != nil {
		ws.Close()
		cancel()
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		ws.Close()
		cancel()
		return nil, err
	}
	go func() { <-child.Done(); ws.SetDeadline(time.Now()); ws.Close() }()
	go c.receive(child)
	return c, nil
}
func validState(f StateFrame) bool {
	if f.Protocol != 1 {
		return false
	}
	if _, err := uuid.Parse(f.OwnerEpoch); err != nil {
		return false
	}
	_, err := strconv.ParseUint(f.Revision, 10, 64)
	return err == nil
}

type stateTiming struct {
	Ownership  string     `json:"ownership_mode"`
	ServerTime time.Time  `json:"server_time"`
	Deadline   *time.Time `json:"authorization_deadline"`
}

// Only this exact projection can change authority without changing business state.
func validRefreshPayload(raw json.RawMessage) bool {
	d := json.NewDecoder(bytes.NewReader(raw))
	open, err := d.Token()
	if err != nil || open != json.Delim('{') {
		return false
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := d.Token()
		name, ok := key.(string)
		if err != nil || !ok || seen[name] {
			return false
		}
		switch name {
		case "ownership_mode", "server_time", "authorization_deadline":
		default:
			return false
		}
		seen[name] = true
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return false
		}
	}
	return len(seen) == 3
}

// Convert server deadlines onto the local monotonic clock. Network delay on a
// later frame can shorten an estimate but can never extend the same deadline.
func (c *StateClient) setTiming(raw json.RawMessage, now time.Time, refresh bool) bool {
	var p stateTiming
	if json.Unmarshal(raw, &p) != nil || p.Ownership != "connection" ||
		(!c.deadline.IsZero() && !now.Before(c.deadline)) {
		return false
	}
	if refresh && (p.Deadline == nil || !p.ServerTime.After(c.lastServerTime) || !validRefreshPayload(raw)) {
		return false
	}
	if !p.ServerTime.IsZero() {
		if p.ServerTime.Before(c.lastServerTime) {
			return false
		}
		c.lastServerTime = p.ServerTime
		if c.serverTime.IsZero() || p.ServerTime.After(c.serverTime.Add(now.Sub(c.received))) {
			c.serverTime, c.received = p.ServerTime, now
		}
	}
	c.deadline = time.Time{}
	if p.Deadline != nil {
		c.deadline = *p.Deadline
		if !c.serverTime.IsZero() {
			c.deadline = c.received.Add(p.Deadline.Sub(c.serverTime))
		}
		return c.deadline.After(now)
	}
	return true
}

func (c *StateClient) send(f StateFrame) error {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return websocket.JSON.Send(c.ws, f)
}
func stateReadDeadline(now, authority time.Time) time.Time {
	deadline := now.Add(stateTransportTimeout)
	if !authority.IsZero() && authority.Before(deadline) {
		return authority
	}
	return deadline
}
func (c *StateClient) receive(ctx context.Context) {
	defer close(c.done)
	defer c.cancel()
	defer func() { c.mu.Lock(); c.live = false; close(c.changed); c.changed = make(chan struct{}); c.mu.Unlock() }()
	for ctx.Err() == nil {
		c.mu.Lock()
		deadline := stateReadDeadline(time.Now(), c.deadline)
		c.mu.Unlock()
		c.ws.SetReadDeadline(deadline)
		var f StateFrame
		if websocket.JSON.Receive(c.ws, &f) != nil {
			return
		}
		c.mu.Lock()
		old := c.snapshot
		c.mu.Unlock()
		if f.StreamID != old.StreamID {
			return
		}
		if f.Type == "state_ping" {
			if f.OwnerEpoch != old.OwnerEpoch || f.Protocol != 1 || f.Scope != nil || f.Auth != nil || f.CommandID != "" || f.Code != "" {
				return
			}
			if f.Revision != "" || f.Payload != nil {
				if !c.subscription.AuthorizationRefresh || f.Revision != old.Revision || f.Payload == nil {
					return
				}
				c.mu.Lock()
				valid := c.setTiming(f.Payload, time.Now(), true)
				if !valid {
					c.live = false
				}
				c.mu.Unlock()
				if !valid || (c.subscription.Forward != nil && c.subscription.Forward(f) != nil) {
					return
				}
				continue
			}
			if c.send(StateFrame{Type: "state_pong", Protocol: 1, StreamID: old.StreamID, OwnerEpoch: old.OwnerEpoch}) != nil {
				return
			}
			continue
		}
		if f.Type == "state_close" {
			return
		}
		if f.Type != "state_delta" && f.Type != "state_snapshot" {
			continue
		}
		if !validState(f) || f.OwnerEpoch != old.OwnerEpoch {
			return
		}
		rev, _ := strconv.ParseUint(f.Revision, 10, 64)
		prior, _ := strconv.ParseUint(old.Revision, 10, 64)
		if rev <= prior {
			continue
		}
		c.mu.Lock()
		if !c.setTiming(f.Payload, time.Now(), false) {
			c.live = false
			c.mu.Unlock()
			return
		}
		c.snapshot = f
		close(c.changed)
		c.changed = make(chan struct{})
		c.mu.Unlock()
		if c.subscription.Forward != nil && c.subscription.Forward(f) != nil {
			return
		}
		if c.send(StateFrame{Type: "state_ack", Protocol: 1, StreamID: f.StreamID, OwnerEpoch: f.OwnerEpoch, Revision: f.Revision}) != nil {
			return
		}
	}
}

// Snapshot exposes the last business revision. AuthorizationDeadline returns the
// current local expiry, which a compact refresh may have changed independently.
func (c *StateClient) Snapshot(out any) (StateFrame, <-chan struct{}, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ok := c.live && (c.deadline.IsZero() || time.Now().Before(c.deadline))
	if out != nil && json.Unmarshal(c.snapshot.Payload, out) != nil {
		ok = false
	}
	return c.snapshot, c.changed, ok
}
func (c *StateClient) Update(payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	f, _, ok := c.Snapshot(nil)
	if !ok {
		return errors.New("state connection unavailable")
	}
	return c.send(StateFrame{Type: "state_update", Protocol: 1, StreamID: f.StreamID, OwnerEpoch: f.OwnerEpoch, Payload: raw})
}
func (c *StateClient) Done() <-chan struct{} { return c.done }
func (c *StateClient) Close()                { c.cancel(); c.ws.SetDeadline(time.Now()); c.ws.Close() }

type stateRelay struct {
	engine    string
	topic     string
	sessionID string // diagnostic identity, counted only after an authenticated snapshot
	lastPong  time.Time
	stopping  bool
	epoch     string
	events    chan StateFrame
	stop      func()
}

func (s *server) state(w http.ResponseWriter, r *http.Request) {
	c := s.waitConnection(r.Context())
	if c == nil {
		s.writeControlUnavailable(w)
		return
	}
	c.mu.Lock()
	enabled := c.stateEnabled
	c.mu.Unlock()
	if !enabled {
		http.Error(w, "control state unavailable", http.StatusUpgradeRequired)
		return
	}
	websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		ws.MaxPayloadBytes = maxFrameBody
		ws.SetReadDeadline(time.Now().Add(15 * time.Second))
		var open StateFrame
		if websocket.JSON.Receive(ws, &open) != nil || open.Type != "state_open" || open.Protocol != 1 || open.Scope == nil {
			return
		}
		if _, err := uuid.Parse(open.StreamID); err != nil {
			return
		}
		stop := func() { ws.SetDeadline(time.Now()) }
		stream := &stateRelay{engine: matrixEngine(open.Scope.Engine), topic: open.Scope.Topic, sessionID: open.Scope.SessionID, events: make(chan StateFrame, 64), stop: stop, lastPong: time.Now()}
		c.mu.Lock()
		if c.states == nil {
			c.states = make(map[string]*stateRelay)
		}
		if c.states[open.StreamID] != nil || len(c.states) >= 256 {
			c.mu.Unlock()
			return
		}
		c.states[open.StreamID] = stream
		c.mu.Unlock()
		defer func() {
			c.mu.Lock()
			if c.states[open.StreamID] == stream {
				delete(c.states, open.StreamID)
			}
			epoch := stream.epoch
			c.mu.Unlock()
			c.send(StateFrame{Type: "state_close", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: epoch})
		}()
		if c.send(open) != nil {
			return
		}
		ws.SetReadDeadline(time.Time{})
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		go func() {
			select {
			case <-c.done:
				stop()
			case <-ctx.Done():
				stop()
			}
		}()
		go func() {
			defer cancel()
			for {
				select {
				case <-ctx.Done():
					return
				case f := <-stream.events:
					ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
					if websocket.JSON.Send(ws, f) != nil {
						return
					}
					if f.Type == "state_close" {
						return
					}
				}
			}
		}()
		for {
			var f StateFrame
			if websocket.JSON.Receive(ws, &f) != nil {
				return
			}
			if f.StreamID != open.StreamID || f.Protocol != 1 || f.Auth != nil || f.Scope != nil {
				return
			}
			switch f.Type {
			case "state_ack", "state_update", "state_pong", "state_receipt", "state_close":
			default:
				return
			}
			if f.Type == "state_pong" {
				if handled, valid := c.acceptLocalStatePong(f, time.Now()); handled {
					if !valid {
						return
					}
					continue
				}
			}
			if c.send(f) != nil || f.Type == "state_close" {
				return
			}
		}
	}).ServeHTTP(w, r)
}
func (c *connection) receiveState(f StateFrame) {
	c.mu.Lock()
	stream := c.states[f.StreamID]
	if stream != nil {
		if f.Type == "state_close" {
			stream.stopping = true
		}
		if (f.Type == "state_snapshot" || f.Type == "state_delta") && f.OwnerEpoch != "" {
			if stream.epoch == "" {
				stream.lastPong = time.Now()
			}
			stream.epoch = f.OwnerEpoch
		}
		select {
		case stream.events <- f:
		default:
			stream.stop()
		}
	}
	c.mu.Unlock()
}

func StateAvailable(ctx context.Context, base string) bool {
	o, ok := OwnerStatus(ctx, base)
	return ok && o.ControlStateProtocol == 1
}

func StateRequired(base string) bool {
	ep := endpointFor(base)
	if ep == nil {
		return false
	}
	ep.mu.Lock()
	defer ep.mu.Unlock()
	return ep.anchor != nil && ep.anchor.Orchestrator.CommunicatorStateProtocol == 1
}

func (c *StateClient) AuthorizationDeadline() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.deadline
}
func (c *StateClient) ServerNow() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.serverTime.IsZero() {
		return time.Now()
	}
	return c.serverTime.Add(time.Since(c.received))
}

// One communicator ticker proves local responsiveness; no per-stream WAN heartbeat.
func (c *connection) pingLocalStates(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.stateLocalLiveness {
		return
	}
	for id, stream := range c.states {
		if stream.epoch == "" || stream.stopping {
			continue
		}
		if now.Sub(stream.lastPong) >= stateTransportTimeout {
			stream.stopping = true
			stream.stop()
			continue
		}
		select {
		case stream.events <- StateFrame{Type: "state_ping", Protocol: 1, StreamID: id, OwnerEpoch: stream.epoch}:
		default:
			stream.stopping = true
			stream.stop()
		}
	}
}
func (c *connection) acceptLocalStatePong(f StateFrame, now time.Time) (handled, valid bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.stateLocalLiveness {
		return false, false
	}
	stream := c.states[f.StreamID]
	if stream == nil || stream.stopping || stream.epoch == "" || stream.epoch != f.OwnerEpoch {
		return true, false
	}
	stream.lastPong = now
	return true, true
}

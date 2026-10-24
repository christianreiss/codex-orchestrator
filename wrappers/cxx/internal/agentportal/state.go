package agentportal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/schedulewatch"
	"golang.org/x/net/websocket"
)

var dialPortalState = communicator.DialState
var portalStateAvailable = communicator.StateAvailable

type sessionState struct {
	observedServerTime    time.Time
	OwnershipMode         string          `json:"ownership_mode"`
	AuthorizationDeadline *time.Time      `json:"authorization_deadline"`
	Session               json.RawMessage `json:"session"`
	Receiver              json.RawMessage `json:"receiver"`
	NativeControl         *struct {
		RequestID  string `json:"request_id"`
		InstanceID string `json:"instance_id"`
	} `json:"native_control"`
	Watchdog *watchdogSnapshot     `json:"watchdog"`
	Schedule *schedulewatch.Policy `json:"schedule"`
}

func (s *Session) stateView() (sessionState, <-chan struct{}, bool, bool) {
	s.mu.Lock()
	c, used := s.state, s.stateUsed
	s.mu.Unlock()
	if c == nil {
		return sessionState{}, nil, false, used
	}
	var view sessionState
	_, changed, live := c.Snapshot(&view)
	view.observedServerTime = c.ServerNow()
	return view, changed, live, used
}

// consumeState holds the attachment until disconnect. A negotiated connection
// never silently restores heartbeat leases when the authority is unavailable.
func (s *Session) consumeState(ctx context.Context) error {
	s.mu.Lock()
	pending := s.pendingRegistration
	s.mu.Unlock()
	if pending {
		return errors.New("registration pending")
	}
	c, err := dialPortalState(ctx, s.BaseURL, communicator.StateScope{Topic: "session", SessionID: s.ID}, communicator.StateAuth{BridgeToken: s.BridgeToken})
	if err != nil {
		return err
	}
	defer c.Close()
	s.mu.Lock()
	s.state = c
	if !s.stateUsed {
		if s.stateReady == nil {
			s.stateReady = make(chan struct{})
		}
		close(s.stateReady)
	}
	s.stateUsed = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.state == c {
			s.state = nil
		}
		s.mu.Unlock()
	}()
	for {
		var view sessionState
		_, changed, live := c.Snapshot(&view)
		if !live {
			return errors.New("state disconnected")
		}
		if s.watchdog != nil {
			s.watchdog.mu.Lock()
			if view.Watchdog != nil {
				s.watchdog.snapshot = *view.Watchdog
				s.watchdog.received = time.Now()
			} else {
				s.watchdog.snapshot = watchdogSnapshot{}
				s.watchdog.received = time.Time{}
			}
			s.watchdog.mu.Unlock()
		}
		var deadline <-chan time.Time
		var timer *time.Timer
		if expires := c.AuthorizationDeadline(); !expires.IsZero() {
			timer = time.NewTimer(time.Until(expires))
			deadline = timer.C
		}
		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return ctx.Err()
		case <-c.Done():
			if timer != nil {
				timer.Stop()
			}
			return errors.New("state disconnected")
		case <-deadline:
			return errors.New("state authorization expired")
		case <-changed:
			if timer != nil {
				timer.Stop()
			}
		}
	}
}

// stateStream exposes one credential-free receiver attachment. Credentials and
// session identity are injected here and cannot be selected by the native client.
func (b *Broker) stateStream(w http.ResponseWriter, r *http.Request) {
	if !b.session.signedReceiverEnabled() {
		writeBrokerError(w, 403, "broker_receiver_forbidden", "Automatic receiver is disabled by signed policy")
		return
	}
	websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		ws.MaxPayloadBytes = brokerBodyLimit
		ws.SetReadDeadline(time.Now().Add(15 * time.Second))
		var open communicator.StateFrame
		if websocket.JSON.Receive(ws, &open) != nil || open.Type != "state_open" || open.Scope == nil || open.Scope.Topic != "receiver" || open.Auth != nil && (open.Auth.BridgeToken != "" || open.Auth.RelayToken != "") {
			return
		}
		scope := *open.Scope
		scope.SessionID = b.session.ID
		scope.RelayID = ""
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		upstream, err := dialPortalState(ctx, b.session.BaseURL, scope, communicator.StateAuth{BridgeToken: b.session.BridgeToken})
		if err != nil {
			return
		}
		defer upstream.Close()
		initial, _, _ := upstream.Snapshot(nil)
		ws.SetReadDeadline(time.Time{})
		go func() {
			defer cancel()
			for {
				ws.SetReadDeadline(time.Now().Add(45 * time.Second))
				var f communicator.StateFrame
				if websocket.JSON.Receive(ws, &f) != nil || f.StreamID != open.StreamID || f.Protocol != 1 || f.OwnerEpoch != initial.OwnerEpoch || f.Auth != nil || f.Scope != nil {
					return
				}
				switch f.Type {
				case "state_ack", "state_pong":
				case "state_update":
					if !b.session.signedReceiverEnabled() {
						return
					}
					var value any
					if json.Unmarshal(f.Payload, &value) != nil || upstream.Update(value) != nil {
						return
					}
				default:
					return
				}
			}
		}()
		go func() { <-ctx.Done(); ws.SetDeadline(time.Now()) }()
		ping := time.NewTicker(15 * time.Second)
		defer ping.Stop()
		first := true
		for {
			frame, changed, live := upstream.Snapshot(nil)
			if !live {
				return
			}
			frame.StreamID = open.StreamID
			if first {
				frame.Type = "state_snapshot"
				first = false
			} else {
				frame.Type = "state_delta"
			}
			ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if websocket.JSON.Send(ws, frame) != nil {
				return
			}
		waiting:
			for {
				select {
				case <-ctx.Done():
					return
				case <-upstream.Done():
					return
				case <-changed:
					break waiting
				case <-ping.C:
					ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
					if websocket.JSON.Send(ws, communicator.StateFrame{Type: "state_ping", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: frame.OwnerEpoch}) != nil {
						return
					}
				}
			}
		}
	}).ServeHTTP(w, r)
}

func (s *Session) stateNegotiated() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stateReady == nil {
		s.stateReady = make(chan struct{})
	}
	return s.stateReady
}

func (s *Session) connectionStateUsed() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.stateUsed }

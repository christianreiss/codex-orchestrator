package communicator

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"time"

	"golang.org/x/net/websocket"
)

// DialDaemon preserves the existing host daemon's local protocol while its
// remote frames share the communicator's one control connection.
func DialDaemon(ctx context.Context, base string) (*websocket.Conn, bool, error) {
	ep := endpointFor(base)
	if ep == nil {
		return nil, false, nil
	}
	if err := ep.ensure(ctx); err != nil {
		return nil, true, err
	}
	ep.once.Do(func() { go ep.lease(processContext) })
	raw, err := (&net.Dialer{}).DialContext(ctx, "unix", ep.socket)
	if err != nil {
		return nil, true, err
	}
	raw.SetDeadline(time.Now().Add(20 * time.Second))
	cfg, err := websocket.NewConfig("ws://communicator.local/_comm/daemon", "http://communicator.local")
	if err != nil {
		raw.Close()
		return nil, true, err
	}
	ws, err := websocket.NewClient(cfg, raw)
	if err != nil {
		raw.Close()
		return nil, true, err
	}
	raw.SetDeadline(time.Time{})
	return ws, true, nil
}

func (s *server) daemon(w http.ResponseWriter, r *http.Request) {
	c := s.waitConnection(r.Context())
	if c == nil {
		writeUnavailable(w, false)
		return
	}
	websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		channel := make(chan json.RawMessage, 64)
		c.mu.Lock()
		if c.daemon != nil {
			c.mu.Unlock()
			return
		}
		c.daemon = channel
		c.mu.Unlock()
		defer func() {
			c.mu.Lock()
			c.daemon = nil
			c.mu.Unlock()
			_ = c.send(map[string]any{"type": "daemon_disconnect"})
		}()
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		go func() {
			defer cancel()
			defer ws.Close()
			for {
				select {
				case <-ctx.Done():
					return
				case <-c.done:
					return
				case raw := <-channel:
					if raw == nil {
						return
					}
					if websocket.Message.Send(ws, string(raw)) != nil {
						return
					}
				}
			}
		}()
		for {
			var raw json.RawMessage
			if websocket.JSON.Receive(ws, &raw) != nil {
				return
			}
			if !json.Valid(raw) {
				return
			}
			if c.send(map[string]any{"type": "daemon", "payload": raw}) != nil {
				return
			}
		}
	}).ServeHTTP(w, r)
}

// connectWait is how long a request may wait for the shared connection. The very
// first connection is worth the full budget. After one failed attempt the retry is
// about a second away, so wait just long enough to ride out a blip. From the second
// consecutive failure the outage is established and, like direct HTTPS refusing in
// milliseconds, the server is reported unavailable at once; otherwise every call of
// a command pays the wait again.
const (
	connectWaitFirst = 20 * time.Second
	connectWaitBlip  = 1500 * time.Millisecond
)

func (s *server) waitConnection(ctx context.Context) *connection {
	start := time.Now()
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		s.mu.Lock()
		c, failures := s.conn, s.failures
		s.mu.Unlock()
		if c != nil {
			return c
		}
		limit := connectWaitFirst
		switch {
		case failures == 1:
			limit = connectWaitBlip
		case failures > 1:
			limit = 0
		}
		if time.Since(start) >= limit {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		}
	}
}

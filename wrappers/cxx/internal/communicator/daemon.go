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
			owned := c.daemon == channel
			if owned {
				c.daemon = nil
			}
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

func (s *server) waitConnection(ctx context.Context) *connection {
	timer := time.NewTimer(20 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		s.mu.Lock()
		c := s.conn
		s.mu.Unlock()
		if c != nil {
			return c
		}
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
			return nil
		case <-tick.C:
		}
	}
}

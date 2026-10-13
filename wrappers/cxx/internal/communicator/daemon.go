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
	if ep == nil || ep.transportDisabled() {
		return nil, false, nil
	}
	if err := ep.ensure(ctx); err != nil {
		return nil, true, err
	}
	ep.once.Do(func() { go ep.lease(processContext) })
	raw, err := (&net.Dialer{}).DialContext(ctx, "unix", ep.localSocket())
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
		s.writeControlUnavailable(w)
		return
	}
	websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		channel := make(chan json.RawMessage, 64)
		c.mu.Lock()
		if c.daemon != nil || c.daemonClosing != nil {
			c.mu.Unlock()
			return
		}
		c.daemon = channel
		// Expired deadlines unblock a stalled Send and the Receive loop without
		// taking the websocket write lock that a blocked Send holds (Close does).
		stop := func() {
			now := time.Now()
			_ = ws.SetWriteDeadline(now)
			_ = ws.SetReadDeadline(now)
		}
		c.daemonStop = stop
		c.mu.Unlock()
		defer c.finishDaemon(channel)
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		// A lost control connection must end this stream even while the relay
		// is blocked writing to a reader that stopped, or the daemon would never
		// notice and reconnect.
		go func() {
			select {
			case <-c.done:
				stop()
			case <-ctx.Done():
			}
		}()
		go func() {
			defer cancel()
			// Close writes a close frame; never let it block on a stalled reader.
			defer func() { stop(); ws.Close() }()
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

// connectWaitFirst caps how long a request waits for the shared connection. It must
// end well inside the shortest deadline of any caller that can be waiting here, the
// 15 s auth worker (authWorkerTimeout): a worker killed while its request still waits
// never learns that nothing was sent, so it cannot take its documented offline path
// and reports a failed sync instead. Waiting is bounded per connection attempt, not
// per request: every request shares the budget of the attempt in flight, so the second
// and third call of a command against a hung API fail at once instead of each
// sitting out the whole budget. Once an attempt has failed, the connect loop sleeps
// in a backoff of up to 30 s, so a waiting request must neither sit through that
// sleep nor fail while the server is already back: it asks the loop to redial now
// and learns the outcome of that one attempt, which for a refused connection takes
// milliseconds, like direct HTTPS. A failure from the last second is reported at once
// instead of redialling for every call of a command.
//
// A redial after the connection was lost is expected within moments (TCP, TLS and the
// upgrade of a server that is back take well under a second), so it gets a much
// shorter budget, redialWait, than the very first connection of a cold owner.
const (
	connectWaitFirst = authWorkerTimeout - 5*time.Second
	redialWait       = 3 * time.Second
	reconnectSpacing = time.Second
)

func (s *server) waitConnection(ctx context.Context) *connection {
	deadline := time.Now().Add(connectWaitFirst)
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	kicked := false
	var kickedAt uint64
	for {
		s.mu.Lock()
		c, failures, attempting, attempts, ended, began := s.conn, s.failures, s.attempting, s.attempts, s.lastAttemptEnd, s.attemptStarted
		s.mu.Unlock()
		if attempting && !began.IsZero() {
			// Waiters share the attempt's budget rather than starting their own.
			budget := connectWaitFirst
			if failures > 0 {
				budget = redialWait
			}
			if shared := began.Add(budget); shared.Before(deadline) {
				deadline = shared
			}
		}
		switch {
		case c != nil:
			return c
		case time.Now().After(deadline):
			return nil
		case attempting, failures == 0:
			// The first connect, or an attempt already in flight, will say.
		case kicked && attempts > kickedAt:
			return nil // the attempt requested above failed: the outage is real
		case !kicked && failures >= 2 && time.Since(ended) < reconnectSpacing:
			return nil
		case !kicked:
			kicked, kickedAt = true, attempts
			s.requestReconnect()
		}
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		}
	}
}

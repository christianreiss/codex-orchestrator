package communicator

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipv4"
	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

type frame struct {
	Engine     string            `json:"engine,omitempty"`
	AccountID  int64             `json:"account_id,omitempty"`
	Generation int64             `json:"generation,omitempty"`
	Payload    json.RawMessage   `json:"payload,omitempty"`
	ID         string            `json:"id,omitempty"`
	Type       string            `json:"type,omitempty"`
	Method     string            `json:"method,omitempty"`
	Path       string            `json:"path,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Body       []byte            `json:"body,omitempty"`
	Status     int               `json:"status,omitempty"`
	Error      string            `json:"error,omitempty"`
	Protocol   int               `json:"protocol,omitempty"`
	Revision   string            `json:"revision,omitempty"`
}

type connection struct {
	daemon        chan json.RawMessage
	daemonClosing chan json.RawMessage
	daemonStop    func()
	ws            *websocket.Conn
	mu            sync.Mutex
	sendMu        sync.Mutex
	pending       map[string]chan frame
	done          chan struct{}
	ready         chan struct{}
	invalidated   func()
	authChanged   func(string, int64)
}

func directTransport(cfg *config.Config) (*http.Transport, error) {
	trust := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: cfg.Orchestrator.AllowInsecure}
	if p := cfg.Orchestrator.CABundlePath; p != nil && *p != "" {
		raw, err := os.ReadFile(*p)
		if err != nil {
			return nil, err
		}
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(raw) {
			return nil, errors.New("CA bundle contains no certificates")
		}
		trust.RootCAs = pool
	}
	return &http.Transport{DialContext: ipv4.PreferDialContext(), TLSClientConfig: trust, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 60 * time.Second, MaxIdleConns: 8, IdleConnTimeout: time.Minute}, nil
}
func dial(ctx context.Context, cfg *config.Config, transport *http.Transport) (*websocket.Conn, error) {
	address := strings.Replace(strings.Replace(strings.TrimRight(cfg.Orchestrator.BaseURL, "/"), "https://", "wss://", 1), "http://", "ws://", 1) + "/host/communicator/connect"
	wc, err := websocket.NewConfig(address, cfg.Orchestrator.BaseURL)
	if err != nil {
		return nil, err
	}
	wc.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	port := wc.Location.Port()
	if port == "" {
		port = "80"
		if wc.Location.Scheme == "wss" {
			port = "443"
		}
	}
	raw, err := transport.DialContext(ctx, "tcp", net.JoinHostPort(wc.Location.Hostname(), port))
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			raw.Close()
		}
	}()
	stop := context.AfterFunc(ctx, func() { raw.Close() })
	defer stop()
	raw.SetDeadline(time.Now().Add(15 * time.Second))
	var wire net.Conn = raw
	if wc.Location.Scheme == "wss" {
		trust := transport.TLSClientConfig.Clone()
		trust.ServerName = wc.Location.Hostname()
		secure := tls.Client(raw, trust)
		if err := secure.HandshakeContext(ctx); err != nil {
			return nil, err
		}
		wire = secure
	}
	ws, err := websocket.NewClient(wc, wire)
	if err != nil {
		return nil, err
	}
	raw.SetDeadline(time.Time{})
	ws.MaxPayloadBytes = 16 * 1024 * 1024
	ok = true
	return ws, nil
}
func (c *connection) send(value any) error {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	c.ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
	return websocket.JSON.Send(c.ws, value)
}
func (c *connection) receive() {
	defer close(c.done)
	defer c.ws.Close()
	ready := false
	for {
		c.ws.SetReadDeadline(time.Now().Add(50 * time.Second))
		var f frame
		if websocket.JSON.Receive(c.ws, &f) != nil {
			return
		}
		switch f.Type {
		case "ready":
			if f.Protocol != Protocol {
				return
			}
			if !ready {
				close(c.ready)
				ready = true
			}
		case "daemon_event", "daemon_closed":
			// Enqueue under c.mu: detachDaemon closes the channel under the same
			// lock (also from the daemon_closed timer), so a late frame can never
			// send on a closed channel. The send is non-blocking.
			c.mu.Lock()
			ch := c.daemon
			overflow := false
			if ch != nil {
				select {
				case ch <- f.Payload:
				default:
					overflow = true
				}
			}
			c.mu.Unlock()
			if overflow {
				// A stalled daemon consumer must not tear down the control
				// connection other engines share. Detach only that stream;
				// the daemon reconnects under its durable work semantics.
				c.detachDaemon(ch)
			}
			if ch != nil {
				if f.Type == "daemon_closed" {
					// Queued events still drain to a reading daemon first; a
					// relay blocked on a stalled reader is stopped after a bound.
					time.AfterFunc(daemonCloseGrace, func() { c.detachDaemon(ch) })
				}
			}
		case "auth_changed":
			if c.authChanged != nil {
				c.authChanged(f.Engine, f.AccountID)
			}
		case "invalidate":
			if c.invalidated != nil {
				c.invalidated()
			}
		default:
			c.mu.Lock()
			ch := c.pending[f.ID]
			c.mu.Unlock()
			if ch != nil {
				select {
				case ch <- f:
				default:
				}
			}
		}
	}
}

// daemonCloseGrace bounds how long a remotely closed daemon stream may keep
// draining queued events before it is stopped.
var daemonCloseGrace = 2 * time.Second

func (c *connection) detachDaemon(ch chan json.RawMessage) {
	c.mu.Lock()
	var stop func()
	if c.daemon == ch {
		c.daemon = nil
		c.daemonClosing = ch
		stop, c.daemonStop = c.daemonStop, nil
		close(ch)
	}
	c.mu.Unlock()
	// A relay already blocked writing to the stalled consumer never sees the
	// closed channel, so the local stream itself is stopped as well.
	if stop != nil {
		stop()
	}
}

// Reserve the previous stream until its remote disconnect is serialized onto
// the control connection. A replacement must never inherit that disconnect.
func (c *connection) finishDaemon(ch chan json.RawMessage) {
	c.mu.Lock()
	if c.daemon != ch && c.daemonClosing != ch {
		c.mu.Unlock()
		return
	}
	c.daemon = nil
	c.daemonClosing = ch
	c.daemonStop = nil
	c.mu.Unlock()
	_ = c.send(map[string]any{"type": "daemon_disconnect"})
	c.mu.Lock()
	if c.daemonClosing == ch {
		c.daemonClosing = nil
	}
	c.mu.Unlock()
}
func (c *connection) request(ctx context.Context, f frame) (frame, bool, error) {
	f.Type = "request"
	f.ID = uuid.NewString()
	ch := make(chan frame, 1)
	c.mu.Lock()
	c.pending[f.ID] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, f.ID); c.mu.Unlock() }()
	if err := c.send(f); err != nil {
		return frame{}, true, err
	}
	select {
	case result := <-ch:
		return result, false, nil
	case <-c.done:
		return frame{}, true, errors.New("communicator connection lost")
	case <-ctx.Done():
		return frame{}, true, ctx.Err()
	}
}
func headers(h http.Header) map[string]string {
	out := map[string]string{}
	for k := range h {
		out[strings.ToLower(k)] = h.Get(k)
	}
	return out
}
func rawJSON(value any) json.RawMessage { raw, _ := json.Marshal(value); return raw }

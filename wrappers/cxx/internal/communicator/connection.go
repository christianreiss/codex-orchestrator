package communicator

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	StateFrame
	cacheDeadline time.Time

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
	// Control, RequestID and Reason carry the optional remote-control frames in
	// control.go; an old server never sets them.
	Control       []string `json:"control,omitempty"`
	StateLiveness string   `json:"state_liveness,omitempty"`
	RequestID     string   `json:"request_id,omitempty"`
	Reason        string   `json:"reason,omitempty"`
	// OwnerInstanceID names the owner process a `terminate` is meant for.
	OwnerInstanceID string `json:"owner_instance_id,omitempty"`
}

type connection struct {
	states               map[string]*stateRelay
	stateEnabled         bool
	stateLivenessOffered bool
	stateLocalLiveness   bool
	daemon               chan json.RawMessage
	daemonClosing        chan json.RawMessage
	daemonStop           func()
	ws                   *websocket.Conn
	mu                   sync.Mutex
	sendMu               sync.Mutex
	pending              map[string]chan frame
	done                 chan struct{}
	ready                chan struct{}
	invalidated          func()
	// updateAvailable wakes the updater; updateAnnounced records that the
	// server offered the wrapper_update trigger.
	updateAvailable func()
	updateAnnounced bool
	authChanged     func(string, int64)
	// onTerminate is set when this owner can be stopped remotely; control is
	// true once the server announced that it may ask.
	onTerminate  func(reason string, acked <-chan struct{})
	preTerminate func() string
	control      bool
	// terminateSeen remembers request ids already answered, so a repeated
	// `terminate` is answered again but stops nothing twice.
	terminateSeen map[string]bool
	// runtimeID names the local namespace this owner serves (see control.go).
	runtimeID string
	// Reporting starts only after the negotiated identity frame was written.
	residentSendMu    sync.Mutex
	residentSequence  uint64
	residentAnnounced bool
	residentReporting bool
	residentSending   bool
	residentReport    func() *residentReport
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
		if errors.Is(err, websocket.ErrBadStatus) {
			return nil, handshakeRejection(ctx, cfg, transport)
		}
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
		case "state_snapshot", "state_delta", "state_ping", "state_close":
			f.StateFrame.Type = f.Type
			f.StateFrame.Protocol = f.Protocol
			f.StateFrame.Revision = f.Revision
			f.StateFrame.Payload = f.Payload
			c.receiveState(f.StateFrame)

		case "state_liveness_ready":
			c.mu.Lock()
			if f.Protocol == Protocol && c.stateLivenessOffered {
				c.stateLocalLiveness = true
				for _, stream := range c.states {
					stream.lastPong = time.Now()
				}
			}
			c.mu.Unlock()
		case "ready":
			if f.Protocol != Protocol {
				return
			}
			if !ready {
				c.mu.Lock()
				c.stateEnabled = announces(f.Control, StateCapability)
				c.stateLivenessOffered = c.stateEnabled && announces(f.Control, StateLivenessCapability)
				c.mu.Unlock()
				close(c.ready)
				ready = true
				if announces(f.Control, controlWrapperUpdate) {
					c.mu.Lock()
					c.updateAnnounced = true
					c.mu.Unlock()
					if c.updateAvailable != nil {
						// A (re)connect may have missed a publish.
						c.updateAvailable()
					}
				}
				if announces(f.Control, controlTerminate) {
					// Remote stop needs a server that can aim it at this process;
					// one that only knows "terminate" is told nothing it cannot parse.
					identity := announces(f.Control, controlOwnerIdentity)
					c.control = identity
					c.mu.Lock()
					c.residentAnnounced = announces(f.Control, controlResidentRuntime)
					c.mu.Unlock()
					go c.announceCapabilities(identity)
				}
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
		case "terminate":
			// Only after the server announced control: a frame this owner never
			// agreed to receive is not an instruction.
			if c.control {
				go c.handleTerminate(f)
			}
		case "auth_changed":
			if c.authChanged != nil {
				c.authChanged(f.Engine, f.AccountID)
			}
		case "invalidate":
			if c.invalidated != nil {
				c.invalidated()
			}
		case "update_available":
			// Only from a server that announced the trigger; it carries no target.
			c.mu.Lock()
			announced := c.updateAnnounced
			c.mu.Unlock()
			if announced && c.updateAvailable != nil {
				c.updateAvailable()
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
	// A connection that already ended cannot have carried this request: say so
	// (definitively not sent, so the caller may retry) instead of attempting a write
	// whose failure would have to be reported as an unknown outcome.
	select {
	case <-c.done:
		return frame{}, false, errors.New("communicator connection lost")
	default:
	}
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

// handshakeRejection asks the server again, outside the WebSocket library, why it
// refused the upgrade. The library reports only "bad status" and discards the
// server's JSON verdict (ip_mismatch, invalid_api_key, communicator_disabled...),
// which is the one thing an operator needs when a host cannot connect. The host key
// is sent exactly as in the handshake and never appears in the returned error.
func handshakeRejection(ctx context.Context, cfg *config.Config, transport *http.Transport) error {
	generic := errors.New("communicator handshake rejected")
	probeCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, strings.TrimRight(cfg.Orchestrator.BaseURL, "/")+"/host/communicator/connect", nil)
	if err != nil {
		return generic
	}
	req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	res, err := (&http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		return generic
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusSwitchingProtocols {
		return generic
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	var verdict struct {
		Message string `json:"message"`
		Code    string `json:"code"`
		Error   *struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	detail := ""
	if json.Unmarshal(raw, &verdict) == nil {
		if verdict.Error != nil {
			if verdict.Code == "" {
				verdict.Code = verdict.Error.Code
			}
			if verdict.Message == "" {
				verdict.Message = verdict.Error.Message
			}
		}
		detail = strings.TrimSpace(verdict.Code)
		if verdict.Message != "" {
			detail = strings.TrimSpace(detail + " (" + verdict.Message + ")")
		}
	}
	if detail == "" {
		detail = oneLine(string(raw), 120)
	}
	return &handshakeRefusal{Status: res.StatusCode, Code: strings.TrimSpace(verdict.Code), Body: raw, detail: oneLine(detail, 200)}
}

// handshakeRefusal is the server's own verdict on a refused upgrade. Its text is
// what operators read in status and 503 bodies; the structured fields let the owner
// answer a request that never left this machine exactly as direct HTTPS would have.
type handshakeRefusal struct {
	Status int
	Code   string
	Body   []byte
	detail string
}

func (e *handshakeRefusal) Error() string {
	return fmt.Sprintf("communicator handshake rejected: HTTP %d %s", e.Status, e.detail)
}

// hostVerdict reports whether the refusal says something about this host's
// credentials rather than about the control channel: 401 (missing or invalid key,
// IP binding, reverse DNS, expired temporary host) and 403 host_<status>. Direct
// HTTPS gives every route that same answer, and wrappers classify it by status
// (a credential verdict is terminal, an outage is retried and falls back to cached
// auth). Anything else, such as a switched-off communicator or the API kill switch,
// is the channel being unavailable and stays a retryable 503.
func (e *handshakeRefusal) hostVerdict() bool {
	return e.Status == http.StatusUnauthorized || e.Status == http.StatusForbidden && strings.HasPrefix(e.Code, "host_")
}

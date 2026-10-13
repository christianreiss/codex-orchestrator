package communicator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

type sharedCall struct {
	done     chan struct{}
	response frame
	unknown  bool
	err      error
}
type server struct {
	jobRefs          map[string]int
	scopes           map[string]*scopeState
	syncCalls        map[string]*syncCall
	active           int
	fallback         bool
	cfg              *config.Config
	version          string
	mu               sync.Mutex
	conn             *connection
	leases           int
	lastUsed         time.Time
	requests, shared uint64
	lastError        string
	// refusal is the server's host-credential verdict (401 / 403 host_*) on the last
	// refused handshake; nil once a connection succeeds or fails for another reason.
	refusal   *handshakeRefusal
	lastSync  string
	calls     map[string]*sharedCall
	dirty     chan struct{}
	authDirty chan struct{}
	jobs      map[string]syncJob
	// failures counts consecutive failed connection attempts; zero means the
	// control connection is either up or still being established for the first time.
	failures int
	// attempting/attempts/lastAttemptEnd let a waiting request tell an attempt in
	// flight from an idle backoff, and kick wakes the backoff for an on-demand redial.
	attempting     bool
	attempts       uint64
	attemptStarted time.Time
	lastAttemptEnd time.Time
	kick           chan struct{}
	policyBusy     atomic.Bool
	// invalidatedAt is when the newest server invalidation arrived (a pushed
	// frame or a reconnect). A content exchange that started earlier cannot
	// satisfy a scheduled pass; everConnected tells a first connection, which has
	// missed nothing, from a reconnect.
	invalidatedAt time.Time
	everConnected bool
	// stop ends the owner (set by serve); terminating makes a remote terminate
	// request single-shot.
	stop        context.CancelFunc
	terminating atomic.Bool
	// draining is set once a remote stop is accepted: no new application work is admitted.
	draining      atomic.Bool
	runtimeID     string
	resident      atomic.Bool
	residentState *residentState
}

func (s *server) configSnapshot() *config.Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

func serve(ctx context.Context, path, version string) error {
	return serveWithResident(ctx, path, version, nil)
}

func serveWithResident(ctx context.Context, path, version string, options *ResidentOptions) error {
	key, err := signing.PublicKey()
	if err != nil {
		return err
	}
	cfg, err := loadSigned(path, key)
	if err != nil {
		return err
	}
	if cfg.Orchestrator.CommunicatorProtocol != Protocol && cfg.Orchestrator.CommunicatorRuntimeProtocol != residency.Protocol {
		return fmt.Errorf("communicator not enabled in signed config")
	}
	socket, err := socketPath(cfg.Orchestrator.BaseURL)
	if err != nil {
		return err
	}
	if cfg.Orchestrator.CommunicatorRuntimeProtocol == residency.Protocol {
		release, err := claimResidentNamespace(cfg.Orchestrator.BaseURL, socket)
		if err != nil {
			return fmt.Errorf("resident owner election: %w", err)
		}
		defer release()
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(filepath.Dir(socket), "owner.lock"))
	if err == ipc.ErrHeld {
		return nil
	}
	if err != nil {
		return err
	}
	defer lock.Release()
	// Only the exclusive owner may remove a socket left by a crashed predecessor.
	if err := os.Remove(socket); err != nil && !os.IsNotExist(err) {
		return err
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(socket)
	if err := os.Chmod(socket, 0600); err != nil {
		return err
	}
	if options != nil {
		if err := options.adoption.acquired(); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s := &server{stop: cancel, runtimeID: runtimeIdentity(socket), kick: make(chan struct{}, 1), cfg: cfg, version: version, lastUsed: time.Now(), calls: map[string]*sharedCall{}, dirty: make(chan struct{}, 1), authDirty: make(chan struct{}, 1), jobs: map[string]syncJob{}, jobRefs: map[string]int{}}
	httpServer := &http.Server{Handler: s, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	if cfg.Orchestrator.CommunicatorRuntimeProtocol == residency.Protocol {
		s.residentState = &residentState{socket: socket}
		httpServer.Handler = residentHandler{s}
	}
	if options != nil {
		if cfg.Orchestrator.CommunicatorRuntimeProtocol != residency.Protocol {
			return fmt.Errorf("resident runtime not enabled in signed config")
		}
		s.residentState = &residentState{options: *options, socket: socket, managed: true}
		s.resident.Store(true)
		httpServer.Handler = residentHandler{s}
		s.residentState.work.Add(1)
		go func() { defer s.residentState.work.Done(); s.residentLoop(ctx) }()
		defer func() { cancel(); s.residentState.work.Wait() }()
	}
	defer httpServer.Close()
	go s.connectLoop(ctx)
	go s.syncLoop(ctx)
	s.supervise(ctx, cancel, httpServer, 5*time.Second, 5*time.Minute)
	err = httpServer.Serve(listener)
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

// supervise ends the process when it is told to stop or has been idle for idleAfter.
// Both paths must close the HTTP server: that is what ends serve(). Cancelling the
// context alone stops the connection and sync loops but leaves the socket
// accepting, so a zombie owner would hold the lock and answer 503 to every client.
func (s *server) supervise(ctx context.Context, cancel context.CancelFunc, httpServer *http.Server, interval, idleAfter time.Duration) {
	go func() {
		<-ctx.Done()
		httpServer.Close()
	}()
	go func() {
		timer := time.NewTicker(interval)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				s.mu.Lock()
				idle := !s.resident.Load() && s.leases == 0 && s.active == 0 && len(s.calls) == 0 && time.Since(s.lastUsed) >= idleAfter
				if s.residentState != nil {
					for _, scope := range s.scopes {
						if scope.running {
							idle = false
						}
					}
					idle = idle && len(s.syncCalls) == 0
				}
				s.mu.Unlock()
				if idle {
					cancel()
					return
				}
			}
		}
	}()
}

func (s *server) invalidate() {
	s.mu.Lock()
	s.invalidatedAt = time.Now()
	s.mu.Unlock()
	s.signalDirty()
}

// signalDirty asks the scheduler for a forced pass without recording that the
// server's state changed.
func (s *server) signalDirty() {
	select {
	case s.dirty <- struct{}{}:
	default:
	}
}

// noteFailureLocked records why the last attempt ended. A host-credential verdict
// from the server is kept only until the next attempt ends, so a stale one is never
// replayed to a request after the cause is gone. s.mu must be held.
func (s *server) noteFailureLocked(err error) {
	if err != nil {
		s.lastError = err.Error()
	}
	s.refusal = nil
	var refused *handshakeRefusal
	if errors.As(err, &refused) && refused.hostVerdict() {
		s.refusal = refused
	}
}

// beginAttempt marks a connection attempt in flight and consumes any stale kick.
func (s *server) beginAttempt() {
	s.mu.Lock()
	s.attempting = true
	s.attempts++
	s.attemptStarted = time.Now()
	s.mu.Unlock()
	select {
	case <-s.kick:
	default:
	}
}

// requestReconnect cuts the reconnect backoff short on behalf of a waiting request.
func (s *server) requestReconnect() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

func (s *server) connectLoop(ctx context.Context) {
	delay := time.Second
	for ctx.Err() == nil {
		s.beginAttempt()
		// Reload the signed file on reconnect so a credential rotation is observed.
		key, _ := signing.PublicKey()
		cfg, err := s.reloadConfig(key)
		if err == nil {
			s.mu.Lock()
			s.cfg = cfg
			s.mu.Unlock()
		}
		if err == nil && cfg.Orchestrator.CommunicatorProtocol != Protocol {
			s.mu.Lock()
			s.fallback = true
			s.mu.Unlock()
			err = fmt.Errorf("communicator disabled in signed config")
		}
		var c *connection
		if err == nil {
			transport, e := directTransport(cfg)
			err = e
			if err == nil {
				dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
				ws, e := dial(dialCtx, cfg, transport)
				cancel()
				err = e
				if err == nil {
					c = &connection{ws: ws, pending: map[string]chan frame{}, done: make(chan struct{}), ready: make(chan struct{}), invalidated: s.invalidate, authChanged: s.invalidateAuth, onTerminate: s.terminate, runtimeID: s.runtimeID, preTerminate: s.preflightStop}
					go c.receive()
					err = c.send(map[string]any{"type": "hello", "protocol": Protocol, "username": communicatorUsername(), "version": s.version})
					if err == nil {
						select {
						case <-c.ready:
						case <-c.done:
							err = fmt.Errorf("communicator handshake rejected")
						case <-ctx.Done():
							err = ctx.Err()
						case <-time.After(15 * time.Second):
							err = fmt.Errorf("communicator handshake timeout")
						}
					}
				}
			}
		}
		if err == nil {
			s.mu.Lock()
			s.conn = c
			s.fallback = false
			s.lastError = ""
			s.refusal = nil
			s.failures = 0
			s.attempting = false
			s.lastAttemptEnd = time.Now()
			firstConnect := !s.everConnected
			s.everConnected = true
			s.mu.Unlock()
			delay = time.Second
			if firstConnect {
				// Nothing was missed by an owner that never had a connection, and a
				// launch's bootstrap that started while this connection was still
				// being made reads server state only after it: it stays fresh.
				s.signalDirty()
			} else {
				s.invalidate()
			}
			timer := time.NewTicker(15 * time.Second)
		live:
			for {
				select {
				case <-c.done:
					break live
				case <-ctx.Done():
					break live
				case <-timer.C:
					s.mu.Lock()
					leases, last := s.leases, s.lastSync
					syncScopes := s.scopeViewsLocked()
					s.mu.Unlock()
					var synced any
					if last != "" {
						synced = last
					}
					if c.send(map[string]any{"type": "heartbeat", "sessions": leases, "synced_at": synced, "sync_scopes": syncScopes}) != nil {
						break live
					}
				}
			}
			timer.Stop()
			err = fmt.Errorf("control connection disconnected")
		}
		if c != nil {
			c.ws.Close()
		}
		s.mu.Lock()
		s.conn = nil
		s.failures++
		s.attempting = false
		s.lastAttemptEnd = time.Now()
		s.noteFailureLocked(err)
		s.mu.Unlock()
		// The policy read may block on a dead network for its whole timeout; it must
		// not hold back the next (possibly requested) connection attempt.
		if s.policyBusy.CompareAndSwap(false, true) {
			go func() {
				defer s.policyBusy.Store(false)
				s.refreshPolicy(ctx)
			}()
		}
		select {
		case <-ctx.Done():
			return
		case <-s.kick:
		case <-time.After(delay + time.Duration(rand.Int63n(int64(delay/2)))):
		}
		if delay < 30*time.Second {
			delay *= 2
		}
		if delay > 30*time.Second {
			delay = 30 * time.Second
		}
	}
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// A stopping owner admits nothing new (status excepted, and the leases and
	// streams already open run down with the process). This is a definitive
	// "not sent": callers retry against the owner that replaces this one.
	if s.draining.Load() && r.URL.Path != "/_comm/status" && r.URL.Path != "/_comm/handoff" {
		writeUnavailableCause(w, false, "communicator is stopping at the server's request")
		return
	}
	s.mu.Lock()
	if r.URL.Path != "/_comm/status" && r.Context().Value(residentRequestKey{}) != true {
		s.lastUsed = time.Now()
	}
	s.mu.Unlock()
	switch r.URL.Path {
	case "/_comm/handoff":
		s.handoff(w, r)
		return
	case "/_comm/daemon":
		s.daemon(w, r)
		return
	case "/_comm/sync":
		s.syncHTTP(w, r)
		return
	case "/_comm/status":
		residentView := s.residentView()
		s.mu.Lock()
		status := map[string]any{"protocol": Protocol, "version": s.version, "pid": os.Getpid(), "connected": s.conn != nil, "https_fallback": s.fallback, "sessions": s.leases, "requests": s.requests, "coalesced": s.shared, "last_error": s.lastError, "synced_at": s.lastSync, "sync_protocol": SyncProtocol, "sync_scopes": s.scopeViewsLocked(), "local_errors": s.localErrorsLocked()}
		s.mu.Unlock()
		for key, value := range residentView {
			status[key] = value
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(status)
		return
	case "/_comm/lease":
		ids, fresh, err := s.registerJobs(r)
		if err != nil {
			http.Error(w, "invalid client scopes", 400)
			return
		}
		defer func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			for _, id := range ids {
				s.jobRefs[id]--
				if s.jobRefs[id] <= 0 {
					delete(s.jobRefs, id)
					delete(s.jobs, id)
				}
			}
		}()
		s.mu.Lock()
		s.leases++
		s.mu.Unlock()
		defer func() { s.mu.Lock(); s.leases--; s.lastUsed = time.Now(); s.mu.Unlock() }()
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		if fresh {
			s.wake()
		}
		lastStates := map[string]string{}
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				s.mu.Lock()
				attached := []syncJob{}
				for _, id := range ids {
					if job, ok := s.jobs[id]; ok && job.Owner && job.Auth {
						attached = append(attached, job)
					}
				}
				s.mu.Unlock()
				for _, job := range attached {
					if signedSyncDisabled(job) {
						s.mu.Lock()
						state := s.stateLocked(job)
						s.mu.Unlock()
						select {
						case state.gate <- struct{}{}:
							<-state.gate
						case <-r.Context().Done():
							return
						}
						_ = json.NewEncoder(w).Encode(AuthStatus{Type: "auth_handoff"})
						w.(http.Flusher).Flush()
						return
					}
				}
				s.mu.Lock()
				states := []AuthStatus{}
				for _, id := range ids {
					if job, ok := s.jobs[id]; ok && job.Auth {
						states = append(states, s.stateLocked(job).auth)
					}
				}
				s.mu.Unlock()
				for _, status := range states {
					raw, _ := json.Marshal(status)
					if lastStates[status.Scope] == string(raw) {
						continue
					}
					lastStates[status.Scope] = string(raw)
					if json.NewEncoder(w).Encode(status) != nil {
						return
					}
				}
				if _, err := io.WriteString(w, "\n"); err != nil {
					return
				}
				w.(http.Flusher).Flush()
			}
		}
	}
	if strings.HasPrefix(r.URL.Path, "/_comm/") {
		http.NotFound(w, r)
		return
	}
	if !managedRequestAllowed(r) {
		http.Error(w, "communicator route forbidden", http.StatusForbidden)
		return
	}
	body, err := bufferedBody(r, 8*1024*1024)
	if err != nil {
		http.Error(w, err.Error(), 413)
		return
	}
	s.mu.Lock()
	s.requests++
	s.active++
	defer func() {
		s.mu.Lock()
		s.active--
		if r.Context().Value(residentRequestKey{}) != true {
			s.lastUsed = time.Now()
		}
		s.mu.Unlock()
	}()
	fallback := s.fallback
	connected := s.conn != nil
	s.mu.Unlock()
	if fallback || r.URL.Path == "/wrapper/v2/config" && !connected {
		s.download(w, r, body)
		return
	}
	// Downloads/large attachments remain inside this process but use independent
	// HTTP streams, keeping interactive control frames bounded. They never need
	// the control connection, so they must not wait for it to reconnect. The
	// path is the one the router dispatches, so a trailing slash still selects
	// the stream.
	routed := requestPath(r)
	if len(body) > maxFrameBody || wrapperArtifactPath(routed) || strings.Contains(routed, "/download") || strings.Contains(routed, "/attachments/") || strings.HasSuffix(routed, "/stream") {
		s.download(w, r, body)
		return
	}
	c := s.waitConnection(r.Context())
	if c == nil {
		s.writeControlUnavailable(w)
		return
	}
	f := frame{Method: r.Method, Path: r.URL.RequestURI(), Headers: headers(r.Header), Body: body}
	var result frame
	var unknown bool
	if coalescible(f) {
		result, unknown, err = s.coalesce(r.Context(), c, f)
	} else {
		result, unknown, err = c.request(r.Context(), f)
	}
	if err != nil {
		s.writeUnavailable(w, unknown)
		return
	}
	// The handler already finished. Retrying a write would repeat it. Idempotent
	// reads can move to the unbounded HTTPS transfer and still return one body.
	if result.Status == http.StatusBadGateway && oversizedResponse(result.Body) {
		if retryOversizedRead(r, body) {
			s.download(w, r, body)
		} else {
			// The operation completed but its result could not be delivered.
			// A 502 would invite the existing clients to retry the mutation.
			writeUnavailable(w, true)
		}
		return
	}
	for k, v := range result.Headers {
		w.Header().Set(k, v)
	}
	if result.Status < 100 {
		s.writeUnavailable(w, true)
		return
	}
	w.WriteHeader(result.Status)
	w.Write(result.Body)
}

func oversizedResponse(body []byte) bool {
	var payload struct {
		Code string `json:"code"`
	}
	return json.Unmarshal(body, &payload) == nil && payload.Code == "communicator_response_too_large"
}

func retryOversizedRead(r *http.Request, body []byte) bool {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		return true
	case http.MethodPost:
		// Bootstrap can exchange auth or admit a session. Reuse the existing
		// byte-identical content-read contract instead of trusting its name.
		return coalescible(frame{Method: r.Method, Path: requestPath(r), Body: body})
	}
	return false
}

// Only concurrent identical reads are shared, never cached authorization or
// mutable MCP replies. The complete body/credential/engine is part of the key.
func coalescible(f frame) bool {
	if f.Method == "GET" {
		return f.Path == "/versions"
	}
	if f.Method != "POST" {
		return false
	}
	if f.Path == "/agents/retrieve" || f.Path == "/config/retrieve" {
		return true
	}
	if f.Path == "/sync/bootstrap" {
		var b map[string]json.RawMessage
		if json.Unmarshal(f.Body, &b) != nil {
			return false
		}
		return string(b["include_auth"]) == "false" && len(b["auth_candidate"]) == 0 && len(b["session_id"]) == 0
	}
	return false
}
func (s *server) coalesce(ctx context.Context, c *connection, f frame) (frame, bool, error) {
	raw, _ := json.Marshal(f)
	sum := sha256.Sum256(raw)
	key := hex.EncodeToString(sum[:])
	s.mu.Lock()
	if call := s.calls[key]; call != nil {
		s.shared++
		s.mu.Unlock()
		select {
		case <-call.done:
			return call.response, call.unknown, call.err
		case <-ctx.Done():
			return frame{}, false, ctx.Err()
		}
	}
	call := &sharedCall{done: make(chan struct{})}
	s.calls[key] = call
	s.mu.Unlock()
	// A cancelled waiter must not cancel another client's identical read.
	go func() {
		work, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		call.response, call.unknown, call.err = c.request(work, f)
		s.mu.Lock()
		delete(s.calls, key)
		close(call.done)
		s.mu.Unlock()
	}()
	select {
	case <-call.done:
		return call.response, call.unknown, call.err
	case <-ctx.Done():
		return frame{}, false, ctx.Err()
	}
}
func (s *server) download(w http.ResponseWriter, r *http.Request, body []byte) {
	if !managedRequestAllowed(r) {
		http.Error(w, "communicator route forbidden", http.StatusForbidden)
		return
	}
	cfg := s.configSnapshot()
	transport, err := directTransport(cfg)
	if err != nil {
		s.writeUnavailable(w, false)
		return
	}
	defer transport.CloseIdleConnections()
	req, err := http.NewRequestWithContext(r.Context(), r.Method, strings.TrimRight(cfg.Orchestrator.BaseURL, "/")+r.URL.RequestURI(), responseBody(body))
	if err != nil {
		s.writeUnavailable(w, false)
		return
	}
	req.Header = transferHeaders(r, cfg.Orchestrator.APIKey)
	res, err := (&http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		s.writeUnavailable(w, r.Method != "GET" && r.Method != "HEAD")
		return
	}
	defer res.Body.Close()
	for k, v := range res.Header {
		w.Header()[k] = v
	}
	w.WriteHeader(res.StatusCode)
	if strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
		w.(http.Flusher).Flush()
		io.Copy(flushWriter{w}, res.Body)
	} else {
		io.Copy(w, res.Body)
	}
}

func communicatorUsername() string {
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	if name := os.Getenv("USER"); name != "" {
		return name
	}
	return fmt.Sprint(os.Getuid())
}

// Keep watchdog heartbeats visible immediately through the local HTTP bridge.
type flushWriter struct{ http.ResponseWriter }

func (w flushWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	w.ResponseWriter.(http.Flusher).Flush()
	return n, err
}

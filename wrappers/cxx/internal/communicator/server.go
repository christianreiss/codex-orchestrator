package communicator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
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
	lastSync         string
	calls            map[string]*sharedCall
	dirty            chan struct{}
	authDirty        chan struct{}
	jobs             map[string]syncJob
	// failures counts consecutive failed connection attempts; zero means the
	// control connection is either up or still being established for the first time.
	failures int
}

func serve(ctx context.Context, path, version string) error {
	key, err := signing.PublicKey()
	if err != nil {
		return err
	}
	cfg, err := loadSigned(path, key)
	if err != nil {
		return err
	}
	if cfg.Orchestrator.CommunicatorProtocol != Protocol {
		return fmt.Errorf("communicator not enabled in signed config")
	}
	socket, err := socketPath(cfg.Orchestrator.BaseURL)
	if err != nil {
		return err
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
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s := &server{cfg: cfg, version: version, lastUsed: time.Now(), calls: map[string]*sharedCall{}, dirty: make(chan struct{}, 1), authDirty: make(chan struct{}, 1), jobs: map[string]syncJob{}, jobRefs: map[string]int{}}
	httpServer := &http.Server{Handler: s, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	defer httpServer.Close()
	go s.connectLoop(ctx)
	go s.syncLoop(ctx)
	go func() {
		timer := time.NewTicker(5 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				httpServer.Close()
				return
			case <-timer.C:
				s.mu.Lock()
				idle := s.leases == 0 && s.active == 0 && len(s.calls) == 0 && time.Since(s.lastUsed) >= 5*time.Minute
				s.mu.Unlock()
				if idle {
					cancel()
					return
				}
			}
		}
	}()
	err = httpServer.Serve(listener)
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (s *server) invalidate() {
	select {
	case s.dirty <- struct{}{}:
	default:
	}
}
func (s *server) connectLoop(ctx context.Context) {
	delay := time.Second
	for ctx.Err() == nil {
		// Reload the signed file on reconnect so a credential rotation is observed.
		key, _ := signing.PublicKey()
		cfg, err := loadSigned(s.cfg.SourcePath(), key)
		if err == nil && cfg.Orchestrator.CommunicatorProtocol != Protocol {
			s.mu.Lock()
			s.fallback = true
			s.mu.Unlock()
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
					c = &connection{ws: ws, pending: map[string]chan frame{}, done: make(chan struct{}), ready: make(chan struct{}), invalidated: s.invalidate, authChanged: s.invalidateAuth}
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
			s.failures = 0
			s.mu.Unlock()
			delay = time.Second
			s.invalidate()
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
		if err != nil {
			s.lastError = err.Error()
		}
		s.mu.Unlock()
		s.refreshPolicy(ctx)
		select {
		case <-ctx.Done():
			return
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
	s.mu.Lock()
	if r.URL.Path != "/_comm/status" {
		s.lastUsed = time.Now()
	}
	s.mu.Unlock()
	switch r.URL.Path {
	case "/_comm/daemon":
		s.daemon(w, r)
		return
	case "/_comm/sync":
		s.syncHTTP(w, r)
		return
	case "/_comm/status":
		s.mu.Lock()
		status := map[string]any{"protocol": Protocol, "version": s.version, "pid": os.Getpid(), "connected": s.conn != nil, "https_fallback": s.fallback, "sessions": s.leases, "requests": s.requests, "coalesced": s.shared, "last_error": s.lastError, "synced_at": s.lastSync, "sync_protocol": SyncProtocol, "sync_scopes": s.scopeViewsLocked(), "local_errors": s.localErrorsLocked()}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(status)
		return
	case "/_comm/lease":
		ids, err := s.registerJobs(r)
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
		if len(ids) > 0 {
			s.invalidate()
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
	body, err := bufferedBody(r, 8*1024*1024)
	if err != nil {
		http.Error(w, err.Error(), 413)
		return
	}
	s.mu.Lock()
	s.requests++
	s.active++
	defer func() { s.mu.Lock(); s.active--; s.lastUsed = time.Now(); s.mu.Unlock() }()
	fallback := s.fallback
	connected := s.conn != nil
	s.mu.Unlock()
	if fallback || r.URL.Path == "/wrapper/v2/config" && !connected {
		s.download(w, r, body)
		return
	}
	c := s.waitConnection(r.Context())
	if c == nil {
		writeUnavailable(w, false)
		return
	}
	f := frame{Method: r.Method, Path: r.URL.RequestURI(), Headers: headers(r.Header), Body: body}
	// Downloads/large attachments remain inside this process but use independent
	// HTTP streams, keeping interactive control frames bounded.
	if len(body) > maxFrameBody || strings.Contains(r.URL.Path, "/download") || strings.Contains(r.URL.Path, "/attachments/") || strings.HasSuffix(r.URL.Path, "/stream") {
		s.download(w, r, body)
		return
	}
	var result frame
	var unknown bool
	if coalescible(f) {
		result, unknown, err = s.coalesce(r.Context(), c, f)
	} else {
		result, unknown, err = c.request(r.Context(), f)
	}
	if err != nil {
		writeUnavailable(w, unknown)
		return
	}
	for k, v := range result.Headers {
		w.Header().Set(k, v)
	}
	if result.Status < 100 {
		writeUnavailable(w, true)
		return
	}
	w.WriteHeader(result.Status)
	w.Write(result.Body)
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
	transport, err := directTransport(s.cfg)
	if err != nil {
		writeUnavailable(w, false)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, strings.TrimRight(s.cfg.Orchestrator.BaseURL, "/")+r.URL.RequestURI(), responseBody(body))
	if err != nil {
		writeUnavailable(w, false)
		return
	}
	req.Header = r.Header.Clone()
	req.Header.Del("Host")
	res, err := (&http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		writeUnavailable(w, r.Method != "GET" && r.Method != "HEAD")
		return
	}
	defer res.Body.Close()
	defer transport.CloseIdleConnections()
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

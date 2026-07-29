package agentportal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const brokerBodyLimit = 256 * 1024

// Broker keeps every network credential in the supervising wrapper process.
// The model process receives only a private Unix-socket path whose handler is
// bound to this one agent session and a narrow set of portal operations.
type Broker struct {
	session    *Session
	ctx        context.Context
	cancel     context.CancelFunc
	dir        string
	socketPath string
	listener   net.Listener
	server     *http.Server
	closeOnce  sync.Once
	closeMu    sync.Mutex
	closeErr   error
	requestMu  sync.Mutex
	requestSeq uint64
	requests   map[uint64]context.CancelFunc
}

func (s *Session) StartBroker(parent context.Context) (*Broker, error) {
	if s == nil || s.ID == "" || s.BridgeToken == "" {
		return nil, errors.New("agent portal: no active session for local broker")
	}
	dir, err := os.MkdirTemp("", "cxx-agent-portal-")
	if err != nil {
		return nil, fmt.Errorf("agent portal: create broker directory: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("agent portal: protect broker directory: %w", err)
	}
	socketPath := filepath.Join(dir, "portal.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("agent portal: listen on broker socket: %w", err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("agent portal: protect broker socket: %w", err)
	}
	brokerCtx, brokerCancel := context.WithCancel(parent)
	broker := &Broker{
		session: s, ctx: brokerCtx, cancel: brokerCancel,
		dir: dir, socketPath: socketPath, listener: listener,
		requests: make(map[uint64]context.CancelFunc),
	}
	broker.server = &http.Server{
		Handler:           broker,
		ReadHeaderTimeout: 3 * time.Second,
		IdleTimeout:       35 * time.Second,
	}
	go func() {
		if serveErr := broker.server.Serve(listener); serveErr != nil &&
			!errors.Is(serveErr, http.ErrServerClosed) && !errors.Is(serveErr, net.ErrClosed) {
			broker.recordCloseError(fmt.Errorf("agent portal broker serve: %w", serveErr))
			// Stop advertising a writable relay as soon as its local capability
			// disappears. This request uses the supervisor's direct bridge client.
			closeCtx, closeCancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = broker.session.Heartbeat(closeCtx, "", "close")
			closeCancel()
			broker.cancel()
		}
	}()
	go func() {
		<-brokerCtx.Done()
		_ = broker.Close()
	}()
	return broker, nil
}

func (b *Broker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost || !b.allowedPath(r.URL.Path) {
		writeBrokerError(w, http.StatusForbidden, "broker_operation_forbidden", "Operation is not available through the agent portal broker")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, brokerBodyLimit+1))
	if err != nil {
		writeBrokerError(w, http.StatusBadRequest, "broker_body_invalid", "Could not read broker request")
		return
	}
	if len(raw) > brokerBodyLimit {
		writeBrokerError(w, http.StatusRequestEntityTooLarge, "broker_body_too_large", "Broker request is too large")
		return
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		raw = []byte("{}")
	}
	if !json.Valid(raw) {
		writeBrokerError(w, http.StatusBadRequest, "broker_body_invalid", "Broker request must be JSON")
		return
	}
	requestCtx, cancel := context.WithCancel(b.ctx)
	b.requestMu.Lock()
	b.requestSeq++
	requestID := b.requestSeq
	b.requests[requestID] = cancel
	b.requestMu.Unlock()
	stopRequestCancel := context.AfterFunc(r.Context(), cancel)
	defer func() {
		stopRequestCancel()
		cancel()
		b.requestMu.Lock()
		delete(b.requests, requestID)
		b.requestMu.Unlock()
	}()
	var output json.RawMessage
	err = b.session.bridgeJSON(requestCtx, http.MethodPost, r.URL.Path, json.RawMessage(raw), &output)
	if err != nil {
		var portalErr *PortalError
		if errors.As(err, &portalErr) {
			writeBrokerError(w, portalErr.Status, portalErr.Code, portalErr.Message)
			return
		}
		writeBrokerError(w, http.StatusBadGateway, "broker_upstream_unavailable", "Portal relay is unavailable")
		return
	}
	if len(output) == 0 {
		output = json.RawMessage(`{}`)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(output)
}

func (b *Broker) allowedPath(path string) bool {
	sessionBase := "/host/agent-sessions/" + url.PathEscape(b.session.ID)
	if path == sessionBase+"/heartbeat" || path == sessionBase+"/events" || path == sessionBase+"/commands/claim" {
		return true
	}
	const ackBase = "/host/agent-commands/"
	if !strings.HasPrefix(path, ackBase) || !strings.HasSuffix(path, "/ack") {
		return false
	}
	messageID := strings.TrimSuffix(strings.TrimPrefix(path, ackBase), "/ack")
	return safeID(messageID) && !strings.Contains(messageID, "/")
}

func (b *Broker) ActivateEnvironment() func() {
	if b == nil {
		return func() {}
	}
	return swapPortalEnvironment(map[string]*string{
		envSocket:        &b.socketPath,
		envSessionID:     &b.session.ID,
		envEngine:        &b.session.Engine,
		envBaseURL:       nil,
		envBridgeToken:   nil,
		envCABundle:      nil,
		envAllowInsecure: nil,
	})
}

// ScrubEnvironment prevents a nested cxx launch or failed broker startup from
// inheriting an outer agent session's local socket capability.
func ScrubEnvironment() func() {
	return swapPortalEnvironment(map[string]*string{
		envSocket:        nil,
		envSessionID:     nil,
		envEngine:        nil,
		envBaseURL:       nil,
		envBridgeToken:   nil,
		envCABundle:      nil,
		envAllowInsecure: nil,
	})
}

func swapPortalEnvironment(values map[string]*string) func() {
	type prior struct {
		value string
		set   bool
	}
	previous := make(map[string]prior, len(values))
	for key, value := range values {
		old, ok := os.LookupEnv(key)
		previous[key] = prior{value: old, set: ok}
		if value == nil {
			_ = os.Unsetenv(key)
		} else {
			_ = os.Setenv(key, *value)
		}
	}
	return func() {
		for key, old := range previous {
			if old.set {
				_ = os.Setenv(key, old.value)
			} else {
				_ = os.Unsetenv(key)
			}
		}
	}
}

func (b *Broker) Close() error {
	if b == nil {
		return nil
	}
	b.closeOnce.Do(func() {
		var closeErr error
		b.cancel()
		b.requestMu.Lock()
		for _, cancelRequest := range b.requests {
			cancelRequest()
		}
		b.requestMu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if shutdownErr := b.server.Shutdown(ctx); shutdownErr != nil {
			// Shutdown does not force active long-poll handlers closed when its
			// context expires. Close cancels those request contexts before the
			// socket directory is removed.
			closeErr = b.server.Close()
		}
		_ = b.listener.Close()
		if removeErr := os.RemoveAll(b.dir); closeErr == nil {
			closeErr = removeErr
		}
		b.recordCloseError(closeErr)
	})
	return b.recordedCloseError()
}

func (b *Broker) recordCloseError(err error) {
	if err == nil {
		return
	}
	b.closeMu.Lock()
	defer b.closeMu.Unlock()
	if b.closeErr == nil {
		b.closeErr = err
	}
}

func (b *Broker) recordedCloseError() error {
	b.closeMu.Lock()
	defer b.closeMu.Unlock()
	return b.closeErr
}

func newUnixHTTPClient(socketPath string, timeout time.Duration) *http.Client {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
		},
		MaxIdleConns:          2,
		IdleConnTimeout:       30 * time.Second,
		ResponseHeaderTimeout: timeout,
	}
	return &http.Client{Transport: transport, Timeout: timeout}
}

func writeBrokerError(w http.ResponseWriter, status int, code, message string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":  "error",
		"code":    code,
		"message": message,
	})
}

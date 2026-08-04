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

// mcpServerName must match the server the orchestrator bakes into the engine
// client config (`client-config.ts`). A rename on either side silently drops
// the agent_* toolset, so keep the two together.
const mcpServerName = "cxx-agent"

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
	if b.requiresChannelReceivePolicy(r.URL.Path, raw) && !b.session.signedChannelReceiveEnabled() {
		writeBrokerError(w, http.StatusForbidden, "broker_receive_forbidden", "Receive-side Channel operations are disabled by signed policy")
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

func (b *Broker) requiresChannelReceivePolicy(path string, body json.RawMessage) bool {
	if b == nil || b.session == nil {
		return true
	}
	sessionBase := "/host/agent-sessions/" + url.PathEscape(b.session.ID)
	messagingBase := sessionBase + "/agent-messaging/"
	if path == messagingBase+"deliveries/claim" {
		return true
	}
	if path == messagingBase+"bind" {
		var request map[string]any
		if json.Unmarshal(body, &request) == nil {
			receiveCapable, _ := request["receive_capable"].(bool)
			return receiveCapable
		}
		return false
	}
	if !strings.HasPrefix(path, messagingBase+"deliveries/") {
		return false
	}
	rest := strings.TrimPrefix(path, messagingBase+"deliveries/")
	messageID, operation, ok := strings.Cut(rest, "/")
	return ok && safeID(messageID) && !strings.Contains(operation, "/") && (operation == "renew" || operation == "ack")
}

func (b *Broker) allowedPath(path string) bool {
	sessionBase := "/host/agent-sessions/" + url.PathEscape(b.session.ID)
	if path == sessionBase+"/heartbeat" || path == sessionBase+"/events" || path == sessionBase+"/commands/claim" {
		return true
	}
	messagingBase := sessionBase + "/agent-messaging/"
	for _, operation := range []string{"list", "send", "reply", "wait", "message", "cancel", "bind", "deliveries/claim"} {
		if path == messagingBase+operation {
			return true
		}
	}
	if strings.HasPrefix(path, messagingBase+"deliveries/") {
		rest := strings.TrimPrefix(path, messagingBase+"deliveries/")
		messageID, operation, ok := strings.Cut(rest, "/")
		if ok && safeID(messageID) && !strings.Contains(operation, "/") && (operation == "renew" || operation == "ack") {
			return true
		}
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

// CodexMCPOverrides returns `-c` arguments that hand this broker's address to
// the `cxx-agent` MCP server.
//
// Codex does not pass its own environment to stdio MCP servers, so the server
// starts with neither CXX_AGENT_PORTAL_SOCKET nor CXX_AGENT_PORTAL_SESSION_ID
// and exits immediately with "agent messaging is available only inside a
// managed cdx/clx lifecycle". Codex reports nothing about it, so the agent_*
// tools are simply absent and the model concludes the bus does not exist.
// Setting the server's `env` table per launch is the only place the values are
// known: they are created by this broker, one directory per lifecycle.
//
// Nothing secret travels here. The socket path and the session id are
// capability *names*; the bridge token stays inside this process, and the
// socket itself is the 0700-directory-guarded capability.
func (b *Broker) CodexMCPOverrides(headless bool) []string {
	if b == nil || strings.TrimSpace(b.socketPath) == "" || b.session == nil {
		return nil
	}
	args := []string{}
	if headless {
		// A peer delivery has no human at the terminal, and Codex routes MCP
		// tool calls through an elicitation addressed to `approvals_reviewer`,
		// which defaults to the user. With nobody to answer, every agent_*
		// call comes back as "user cancelled MCP tool call". Automatic review
		// is the reviewer Codex provides for exactly this case; it changes who
		// answers the prompt, not the sandbox boundary. Interactive lifecycles
		// deliberately keep the user as reviewer.
		// Every field is required, and every one is false: an unattended run
		// already cannot answer a prompt, which is what `approval_policy =
		// "never"` means for it. Spelling it out granularly changes only the
		// MCP category, which otherwise auto-cancels instead of proceeding.
		// This does not widen the sandbox — that is `sandbox_mode`, untouched.
		args = append(args, "-c", `approval_policy={granular={sandbox_approval=false,rules=false,mcp_elicitations=false,request_permissions=false,skill_approval=false}}`)
	}
	return append(args,
		"-c",
		// The server name is a TOML *bare* key here on purpose. Quoting it
		// makes Codex's dotted-path parser address a different table, which
		// then has no `command` and fails the whole config with
		// "invalid transport in `mcp_servers.\"cxx-agent\"`". Bare merges into
		// the baked `[mcp_servers.cxx-agent]` and only adds `env`.
		fmt.Sprintf(
			"mcp_servers.%s.env={%s=%s,%s=%s}",
			mcpServerName,
			envSocket, tomlQuote(b.socketPath),
			envSessionID, tomlQuote(b.session.ID),
		),
	)
}

// tomlQuote renders a TOML basic string. Only the escapes TOML requires for a
// path or an opaque id are handled; anything containing a control character is
// rejected upstream by refusing to emit the override at all.
func tomlQuote(value string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		default:
			out.WriteRune(r)
		}
	}
	out.WriteByte('"')
	return out.String()
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

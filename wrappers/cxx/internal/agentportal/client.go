// Package agentportal connects one supervised cxx lifecycle to the public
// agent portal. Host authentication is used only to register the lifecycle;
// every subsequent request uses the short-lived, session-scoped bridge token.
package agentportal

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/user"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

const (
	envSocket              = "CXX_AGENT_PORTAL_SOCKET"
	envBaseURL             = "CXX_AGENT_PORTAL_BASE_URL"
	envSessionID           = "CXX_AGENT_PORTAL_SESSION_ID"
	envBridgeToken         = "CXX_AGENT_PORTAL_BRIDGE_TOKEN"
	envCABundle            = "CXX_AGENT_PORTAL_CA_BUNDLE"
	envAllowInsecure       = "CXX_AGENT_PORTAL_ALLOW_INSECURE"
	envEngine              = "CXX_AGENT_PORTAL_ENGINE"
	envMessagingAddress    = "CXX_AGENT_MESSAGING_ADDRESS"
	envMessagingGeneration = "CXX_AGENT_MESSAGING_BINDING_GENERATION"
	envMessagingContinuity = "CXX_AGENT_MESSAGING_CONTINUITY"
	envMessagingUpstream   = "CXX_AGENT_MESSAGING_UPSTREAM_SESSION_ID"
)

type StartInput struct {
	Engine            string
	InvocationKind    string
	Resumed           bool
	UpstreamSessionID string
}

// ExplicitResumeSessionID extracts only an explicit canonical native session
// UUID from the wrapper's normalized resume argv. Picker/--last forms and
// arbitrary prompt text deliberately return empty so portal continuity never
// guesses at a native identity.
func ExplicitResumeSessionID(args []string) string {
	if len(args) == 0 {
		return ""
	}
	var candidate string
	switch {
	case (args[0] == "resume" || args[0] == "--resume" || args[0] == "-r") && len(args) > 1:
		candidate = strings.TrimSpace(args[1])
	case strings.HasPrefix(args[0], "--resume="):
		candidate = strings.TrimSpace(strings.TrimPrefix(args[0], "--resume="))
	}
	if !isCanonicalUUID(candidate) {
		return ""
	}
	return candidate
}

type Session struct {
	ID                     string
	BridgeToken            string
	BaseURL                string
	CABundlePath           string
	AllowInsecure          bool
	Engine                 string
	hostAPIKey             string
	http                   *http.Client
	registrationBody       map[string]any
	registrationGeneration uint64
	messagingRecovery      bool
	messagingConfigPath    string
	channelReceiveAllowed  bool
	listenAllowed          bool
	localBroker            bool
	mu                     sync.Mutex
	recoverMu              sync.Mutex
	finished               bool
	retryAttemptTimeout    time.Duration
}

type PortalError struct {
	Status  int
	Code    string
	Message string
	Path    string
}

func (e *PortalError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("agent portal %s: %s (%s)", e.Path, e.Message, e.Code)
	}
	return fmt.Sprintf("agent portal %s: HTTP %d: %s", e.Path, e.Status, e.Message)
}

type ClaimedMessage struct {
	MessageID  string  `json:"message_id"`
	Sequence   int64   `json:"sequence"`
	Kind       string  `json:"kind"`
	PromptID   *string `json:"prompt_id"`
	Content    string  `json:"content"`
	Attempts   int     `json:"attempts"`
	LeaseOwner string  `json:"lease_owner"`
	CreatedAt  string  `json:"created_at"`
}

type registerResponse struct {
	Enabled      bool   `json:"enabled"`
	SessionID    string `json:"session_id"`
	BridgeToken  string `json:"bridge_token"`
	ExpiresAt    string `json:"expires_at"`
	AgentAddress *struct {
		Address           string `json:"address"`
		BindingGeneration int    `json:"binding_generation"`
	} `json:"agent_address,omitempty"`
}

type claimResponse struct {
	Message *ClaimedMessage `json:"message"`
}

// Start registers the current root lifecycle. A disabled portal is a normal
// no-op; connectivity failures are returned so the wrapper can log them while
// still allowing the local agent to start.
func Start(parent context.Context, cfg *config.Config, input StartInput) (*Session, error) {
	if cfg == nil {
		return nil, errors.New("agent portal: wrapper config is nil")
	}
	client, err := newHTTPClient(cfg.Orchestrator.CABundlePath, cfg.Orchestrator.AllowInsecure, 8*time.Second)
	if err != nil {
		return nil, err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("agent portal: determine cwd: %w", err)
	}
	username := currentUsername()
	peerAddress := strings.TrimSpace(os.Getenv(envMessagingAddress))
	upstreamSessionID := strings.TrimSpace(input.UpstreamSessionID)
	if peerAddress != "" {
		input.InvocationKind = "peer_delivery"
		if value := strings.TrimSpace(os.Getenv(envMessagingUpstream)); value != "" {
			upstreamSessionID = value
		}
		input.Resumed = upstreamSessionID != ""
	}
	body := map[string]any{
		"engine":              input.Engine,
		"username":            username,
		"cwd":                 cwd,
		"invocation_kind":     input.InvocationKind,
		"resumed":             input.Resumed,
		"upstream_session_id": emptyToNil(upstreamSessionID),
	}
	if peerAddress != "" {
		body["agent_address"] = peerAddress
		if generation, parseErr := strconv.Atoi(strings.TrimSpace(os.Getenv(envMessagingGeneration))); parseErr == nil && generation >= 0 {
			body["binding_generation"] = generation
		}
		if continuity := strings.TrimSpace(os.Getenv(envMessagingContinuity)); continuity == "native" || continuity == "reset" {
			body["continuity"] = continuity
		}
	}
	sessionID := newUUID()
	bridgeToken, err := newBridgeToken()
	if err != nil {
		return nil, err
	}
	body["session_id"] = sessionID
	body["bridge_token"] = bridgeToken
	var response registerResponse
	var registerErr error
	for attempt := 0; attempt < 2; attempt++ {
		ctx, cancel := context.WithTimeout(parent, 8*time.Second)
		registerErr = doJSON(ctx, client, strings.TrimRight(cfg.Orchestrator.BaseURL, "/"), http.MethodPost, "/host/agent-sessions", body, cfg.Orchestrator.APIKey, "", &response)
		cancel()
		if registerErr == nil {
			break
		}
		if attempt == 0 {
			select {
			case <-parent.Done():
				return nil, parent.Err()
			case <-time.After(150 * time.Millisecond):
			}
		}
	}
	if registerErr != nil {
		return nil, registerErr
	}
	if !response.Enabled {
		return nil, nil
	}
	if response.SessionID == "" || response.BridgeToken == "" {
		return nil, errors.New("agent portal: registration returned an incomplete bridge credential")
	}
	if response.AgentAddress != nil && response.AgentAddress.Address != "" {
		body["agent_address"] = response.AgentAddress.Address
		body["binding_generation"] = response.AgentAddress.BindingGeneration
	}
	ca := ""
	if cfg.Orchestrator.CABundlePath != nil {
		ca = strings.TrimSpace(*cfg.Orchestrator.CABundlePath)
	}
	return &Session{
		ID:                     response.SessionID,
		BridgeToken:            response.BridgeToken,
		BaseURL:                strings.TrimRight(cfg.Orchestrator.BaseURL, "/"),
		CABundlePath:           ca,
		AllowInsecure:          cfg.Orchestrator.AllowInsecure,
		Engine:                 input.Engine,
		hostAPIKey:             cfg.Orchestrator.APIKey,
		http:                   client,
		registrationBody:       body,
		registrationGeneration: 1,
		messagingRecovery:      cfg.AgentMessaging.Enabled,
		messagingConfigPath:    cfg.SourcePath(),
		// Receive-side Channel access is derived from both the signed config's
		// engine and policy, never from child-provided environment or MCP input.
		channelReceiveAllowed: signedChannelReceiveAllowed(cfg, input.Engine),
		listenAllowed:         signedListenAllowed(cfg),
	}, nil
}

func signedChannelReceiveAllowed(cfg *config.Config, sessionEngine string) bool {
	return cfg != nil &&
		sessionEngine == config.EngineClaude &&
		cfg.Engine == config.EngineClaude &&
		cfg.AgentMessaging.Enabled &&
		cfg.AgentMessaging.ChannelPreviewEnabled
}

// signedListenAllowed governs the model-initiated receive plane.
//
// Deliberately engine-neutral: unlike Channel, which pushes peer content into a
// Claude transcript with nobody having asked for it, `agent_listen` returns
// content in a tool result the model requested -- the same risk class as
// `agent_wait`, which is ungated today. Codex needs this path as much as Claude.
func signedListenAllowed(cfg *config.Config) bool {
	return cfg != nil && cfg.AgentMessaging.Enabled && cfg.AgentMessaging.ListenEnabled
}

// StartHeartbeat keeps the scoped bridge alive and makes offline detection
// useful without turning heartbeat failures into local-agent failures.
func (s *Session) StartHeartbeat(parent context.Context) func() {
	if s == nil {
		return func() {}
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				heartbeatCtx, heartbeatCancel := context.WithTimeout(context.Background(), 6*time.Second)
				_ = s.Heartbeat(heartbeatCtx, "", "")
				heartbeatCancel()
			}
		}
	}()
	return func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	}
}

func (s *Session) Heartbeat(ctx context.Context, status, relayAction string) error {
	return s.HeartbeatTurn(ctx, status, relayAction, nil)
}

// HeartbeatTurn is Heartbeat plus the turn the agent is currently inside.
//
// Passing nil leaves active_turn_id untouched, which is what every liveness
// beat wants. Passing a pointer sets it: a message ID while the agent executes
// an instruction, or an empty string to report that it has come back. That is
// the only signal separating "working on your instruction" from "stopped
// polling"; without it the portal calls both of them "Not listening".
func (s *Session) HeartbeatTurn(ctx context.Context, status, relayAction string, activeTurnID *string) error {
	body := map[string]any{}
	if strings.TrimSpace(status) != "" {
		body["status"] = strings.TrimSpace(status)
	}
	if strings.TrimSpace(relayAction) != "" {
		body["relay_action"] = strings.TrimSpace(relayAction)
	}
	if activeTurnID != nil {
		if turn := strings.TrimSpace(*activeTurnID); turn != "" {
			body["active_turn_id"] = turn
		} else {
			body["active_turn_id"] = nil
		}
	}
	return s.bridgeJSON(ctx, http.MethodPost, "/host/agent-sessions/"+url.PathEscape(s.ID)+"/heartbeat", body, nil)
}

func (s *Session) Event(ctx context.Context, clientEventID, eventType string, payload map[string]any) error {
	if strings.TrimSpace(clientEventID) == "" {
		clientEventID = newUUID()
	}
	body := map[string]any{
		"client_event_id": clientEventID,
		"type":            eventType,
		"payload":         payload,
	}
	path := "/host/agent-sessions/" + url.PathEscape(s.ID) + "/events"
	return retryAmbiguous(ctx, s.attemptTimeout(6*time.Second), func(attemptCtx context.Context) error {
		return s.bridgeJSON(attemptCtx, http.MethodPost, path, body, nil)
	})
}

func (s *Session) Claim(ctx context.Context, waitSeconds int, claimID string) (*ClaimedMessage, error) {
	if waitSeconds < 0 {
		waitSeconds = 0
	}
	if waitSeconds > 25 {
		waitSeconds = 25
	}
	var out claimResponse
	err := s.bridgeJSON(ctx, http.MethodPost, "/host/agent-sessions/"+url.PathEscape(s.ID)+"/commands/claim", map[string]any{
		"wait_seconds": waitSeconds,
		"claim_id":     claimID,
	}, &out)
	return out.Message, err
}

func (s *Session) Acknowledge(ctx context.Context, message *ClaimedMessage, outcome, upstreamID, errorText string) error {
	if message == nil {
		return errors.New("agent portal: cannot acknowledge a nil message")
	}
	body := map[string]any{
		"session_id":  s.ID,
		"lease_owner": message.LeaseOwner,
		"outcome":     outcome,
		"upstream_id": emptyToNil(upstreamID),
		"error":       emptyToNil(errorText),
	}
	path := "/host/agent-commands/" + url.PathEscape(message.MessageID) + "/ack"
	return retryAmbiguous(ctx, s.attemptTimeout(6*time.Second), func(attemptCtx context.Context) error {
		return s.bridgeJSON(attemptCtx, http.MethodPost, path, body, nil)
	})
}

func (s *Session) Finish(status, summary string) error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	if s.finished {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	body := map[string]any{"status": status, "summary": summary}
	path := "/host/agent-sessions/" + url.PathEscape(s.ID) + "/finish"
	err := retryAmbiguous(context.Background(), s.attemptTimeout(8*time.Second), func(attemptCtx context.Context) error {
		return s.bridgeJSON(attemptCtx, http.MethodPost, path, body, nil)
	})
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.finished = true
	s.mu.Unlock()
	return nil
}

func (s *Session) attemptTimeout(fallback time.Duration) time.Duration {
	if s != nil && s.retryAttemptTimeout > 0 {
		return s.retryAttemptTimeout
	}
	return fallback
}

func retryAmbiguous(parent context.Context, attemptTimeout time.Duration, operation func(context.Context) error) error {
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		if parentErr := parent.Err(); parentErr != nil {
			return parentErr
		}
		attemptCtx, cancel := context.WithTimeout(parent, attemptTimeout)
		err = operation(attemptCtx)
		cancel()
		if err == nil || !isRetryableAmbiguous(err) {
			return err
		}
	}
	return err
}

func (s *Session) bridgeJSON(ctx context.Context, method, path string, body, out any) error {
	if s == nil || s.ID == "" || (!s.localBroker && s.BridgeToken == "") {
		return errors.New("agent portal: no active bridge session")
	}
	if s.localBroker {
		return doJSON(ctx, s.http, s.BaseURL, method, path, body, "", "", out)
	}
	s.mu.Lock()
	generation := s.registrationGeneration
	s.mu.Unlock()
	err := doJSON(ctx, s.http, s.BaseURL, method, path, body, "", s.BridgeToken, out)
	if !s.canRecoverBridgeError(err) {
		return err
	}
	if recoverErr := s.recoverRegistration(ctx, generation); recoverErr != nil {
		return recoverErr
	}
	return doJSON(ctx, s.http, s.BaseURL, method, path, body, "", s.BridgeToken, out)
}

func (s *Session) canRecoverBridgeError(err error) bool {
	if portalErrorCode(err, "agent_bridge_expired") {
		return true
	}
	if s == nil || !s.signedMessagingRecoveryEnabled() {
		return false
	}
	return portalErrorCode(err, "agent_messaging_binding_stale") || portalErrorCode(err, "agent_messaging_address_disabled")
}

func (s *Session) signedMessagingRecoveryEnabled() bool {
	if s == nil || !s.messagingRecovery {
		return false
	}
	if strings.TrimSpace(s.messagingConfigPath) == "" {
		// Test/embedded sessions without loader metadata keep the immutable
		// policy captured at Start. Production signed loads always set a source path.
		return true
	}
	pubkey, err := signing.PublicKey()
	if err != nil {
		return false
	}
	cfg, err := config.LoadForEngine(s.messagingConfigPath, pubkey, false, s.Engine)
	return err == nil && cfg.AgentMessaging.Enabled
}

func (s *Session) signedChannelReceiveEnabled() bool {
	if s == nil || s.Engine != config.EngineClaude || !s.channelReceiveAllowed {
		return false
	}
	if strings.TrimSpace(s.messagingConfigPath) == "" {
		// Manually constructed/test sessions have no loader metadata. Production
		// sessions re-check the current signed file below before every receive-side
		// broker operation so an administrator can revoke Channel immediately.
		return true
	}
	pubkey, err := signing.PublicKey()
	if err != nil {
		return false
	}
	cfg, err := config.LoadForEngine(s.messagingConfigPath, pubkey, false, config.EngineClaude)
	return err == nil && cfg.Engine == config.EngineClaude && cfg.AgentMessaging.Enabled && cfg.AgentMessaging.ChannelPreviewEnabled
}

func (s *Session) signedListenEnabled() bool {
	if s == nil || !s.listenAllowed {
		return false
	}
	if strings.TrimSpace(s.messagingConfigPath) == "" {
		// Same contract as signedChannelReceiveEnabled: manually constructed and
		// test sessions carry no loader metadata, while production sessions
		// re-verify the signed file below on every gated broker request, so an
		// administrator revoking listen takes effect without a restart.
		return true
	}
	pubkey, err := signing.PublicKey()
	if err != nil {
		return false
	}
	cfg, err := config.LoadForEngine(s.messagingConfigPath, pubkey, false, s.Engine)
	return err == nil && cfg.AgentMessaging.Enabled && cfg.AgentMessaging.ListenEnabled
}

// signedReceivePlaneEnabled is the gate the broker applies to a claim or a
// receive-capable bind. Either grant is sufficient: Channel keeps its
// Claude-only preview check, and listen is the engine-neutral one.
func (s *Session) signedReceivePlaneEnabled() bool {
	return s.signedListenEnabled() || s.signedChannelReceiveEnabled()
}

func SessionFromEnvironment(timeout time.Duration) (*Session, error) {
	socketPath := strings.TrimSpace(os.Getenv(envSocket))
	sessionID := strings.TrimSpace(os.Getenv(envSessionID))
	if socketPath == "" || sessionID == "" {
		return nil, errors.New("agent portal is unavailable in this process; run #afk inside a cdx/clx managed session")
	}
	client := newUnixHTTPClient(socketPath, timeout)
	return &Session{
		ID:          sessionID,
		BaseURL:     "http://agent-portal.local",
		Engine:      strings.TrimSpace(os.Getenv(envEngine)),
		http:        client,
		localBroker: true,
	}, nil
}

func doJSON(ctx context.Context, client *http.Client, baseURL, method, path string, body any, hostAPIKey, bridgeToken string, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "cxx-agent-portal/1")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if hostAPIKey != "" {
		req.Header.Set("X-API-Key", hostAPIKey)
	}
	if bridgeToken != "" {
		req.Header.Set("X-Agent-Bridge-Token", bridgeToken)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("agent portal %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		return readErr
	}
	if resp.StatusCode >= 400 {
		var failure struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		}
		_ = json.Unmarshal(raw, &failure)
		if failure.Message == "" {
			failure.Message = http.StatusText(resp.StatusCode)
		}
		return &PortalError{Status: resp.StatusCode, Code: failure.Code, Message: failure.Message, Path: path}
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var probe struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return fmt.Errorf("agent portal %s: decode response: %w", path, err)
	}
	payload := raw
	if len(probe.Data) > 0 && string(probe.Data) != "null" {
		payload = probe.Data
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("agent portal %s: decode payload: %w", path, err)
	}
	return nil
}

func (s *Session) recoverRegistration(ctx context.Context, observedGeneration uint64) error {
	if s == nil || s.localBroker || s.hostAPIKey == "" {
		return errors.New("agent portal: bridge recovery is unavailable")
	}
	s.recoverMu.Lock()
	defer s.recoverMu.Unlock()
	s.mu.Lock()
	if len(s.registrationBody) == 0 {
		s.mu.Unlock()
		return errors.New("agent portal: bridge recovery is unavailable")
	}
	if s.finished {
		s.mu.Unlock()
		return errors.New("agent portal: finished session cannot recover")
	}
	if s.registrationGeneration != observedGeneration {
		s.mu.Unlock()
		return nil
	}
	registrationBody := make(map[string]any, len(s.registrationBody))
	for key, value := range s.registrationBody {
		registrationBody[key] = value
	}
	s.mu.Unlock()
	var response registerResponse
	if err := doJSON(ctx, s.http, s.BaseURL, http.MethodPost, "/host/agent-sessions", registrationBody, s.hostAPIKey, "", &response); err != nil {
		return err
	}
	if !response.Enabled || response.SessionID != s.ID || response.BridgeToken != s.BridgeToken {
		return errors.New("agent portal: bridge recovery returned a different session credential")
	}
	s.mu.Lock()
	if response.AgentAddress != nil && response.AgentAddress.Address != "" {
		registrationBody["agent_address"] = response.AgentAddress.Address
		registrationBody["binding_generation"] = response.AgentAddress.BindingGeneration
	}
	s.registrationBody = registrationBody
	s.registrationGeneration++
	s.mu.Unlock()
	return nil
}

func portalErrorCode(err error, code string) bool {
	var portalErr *PortalError
	return errors.As(err, &portalErr) && portalErr.Code == code
}

func isRetryableAmbiguous(err error) bool {
	if err == nil {
		return false
	}
	var portalErr *PortalError
	if !errors.As(err, &portalErr) {
		return true
	}
	return portalErr.Code == "broker_upstream_unavailable" ||
		portalErr.Status == http.StatusBadGateway ||
		portalErr.Status == http.StatusGatewayTimeout
}

func newHTTPClient(caBundlePath *string, allowInsecure bool, timeout time.Duration) (*http.Client, error) {
	// #nosec G402 -- this is an explicit signed per-host fleet setting and
	// mirrors the existing orchestrator clients.
	tlsConfig := &tls.Config{InsecureSkipVerify: allowInsecure}
	if caBundlePath != nil && strings.TrimSpace(*caBundlePath) != "" {
		raw, err := os.ReadFile(strings.TrimSpace(*caBundlePath))
		if err != nil {
			return nil, fmt.Errorf("agent portal: read CA bundle: %w", err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(raw) {
			return nil, errors.New("agent portal: CA bundle contained no certificates")
		}
		tlsConfig.RootCAs = pool
	}
	responseHeaderTimeout := 35 * time.Second
	if timeout > responseHeaderTimeout {
		responseHeaderTimeout = timeout
	}
	transport := &http.Transport{
		TLSClientConfig:       tlsConfig,
		MaxIdleConns:          4,
		IdleConnTimeout:       45 * time.Second,
		TLSHandshakeTimeout:   8 * time.Second,
		ResponseHeaderTimeout: responseHeaderTimeout,
	}
	// Every call already has a bounded context. A client-wide eight-second
	// timeout would abort the documented 20-25 second command long poll.
	return &http.Client{Transport: transport}, nil
}

func currentUsername() string {
	if current, err := user.Current(); err == nil && strings.TrimSpace(current.Username) != "" {
		return current.Username
	}
	for _, key := range []string{"USER", "LOGNAME"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return "unknown"
}

func emptyToNil(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func newUUID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		// rand.Read only fails on a broken kernel entropy source. Keep this
		// visibly non-secret ID unique enough without exposing any credential.
		now := time.Now().UnixNano()
		for i := range raw {
			raw[i] = byte(now >> (i % 8 * 8))
		}
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	hexID := hex.EncodeToString(raw)
	return hexID[0:8] + "-" + hexID[8:12] + "-" + hexID[12:16] + "-" + hexID[16:20] + "-" + hexID[20:32]
}

func newBridgeToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("agent portal: generate bridge credential: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func safeID(value string) bool {
	if len(value) < 8 || len(value) > 80 {
		return false
	}
	for _, r := range value {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-') {
			return false
		}
	}
	return true
}

func isCanonicalUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for index, r := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

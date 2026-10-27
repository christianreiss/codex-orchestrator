package communicator

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/httpguard"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	"github.com/google/uuid"
)

type ResidentOptions struct {
	Controller   func() residency.ExecutionController
	DirectDaemon func(context.Context, string) (residency.DaemonStream, error)
	adoption     *residentAdoption
}

func ServeResident(ctx context.Context, path, version string, options ResidentOptions) error {
	if options.Controller == nil || options.DirectDaemon == nil {
		return errors.New("resident runtime composition is incomplete")
	}
	key, err := signing.PublicKey()
	if err != nil {
		return err
	}
	cfg, err := loadSigned(path, key)
	if err != nil {
		return err
	}
	if cfg.Orchestrator.CommunicatorRuntimeProtocol != residency.Protocol {
		return errors.New("resident runtime not enabled in signed config")
	}
	options.adoption, err = adoptOnDemandOwner(ctx, cfg.Orchestrator.BaseURL)
	if err != nil {
		return err
	}
	return serveWithResident(ctx, path, version, &options)
}

type residentPolicy struct {
	Enabled            bool   `json:"enabled"`
	ResidentEnabled    bool   `json:"resident_enabled"`
	ExecutionRequested bool   `json:"execution_requested"`
	Username           string `json:"username"`
	ExpiresAt          string `json:"expires_at"`
}

func (p residentPolicy) executionEnabled() bool {
	if !p.Enabled {
		return false
	}
	if p.ExpiresAt == "" {
		return true
	}
	deadline, err := time.Parse(time.RFC3339Nano, p.ExpiresAt)
	return err == nil && time.Now().Before(deadline)
}

type residentState struct {
	mu              sync.Mutex
	work            sync.WaitGroup
	managed         bool
	options         ResidentOptions
	socket          string
	policy          residentPolicy
	controller      residency.ExecutionController
	cancelExecution context.CancelFunc
	lastError       string
	pending         int
	legacyClients   int
	handoffID       string
	handoffChecking bool
	handoffReady    bool
}

// Resident owners account for admission before dispatch, including requests
// that have not yet reached server.active. Lease streams are reconnectable only
// when the client explicitly describes the new runtime protocol.
type residentHandler struct{ s *server }
type residentRequestKey struct{}

func (h residentHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s := h.s
	if r.Header.Get("X-CXX-Internal-Resident") == "1" {
		r = r.WithContext(context.WithValue(r.Context(), residentRequestKey{}, true))
		r.Header.Del("X-CXX-Internal-Resident")
	}
	if r.URL.Path == "/_comm/status" || r.URL.Path == "/_comm/handoff" {
		s.ServeHTTP(w, r)
		return
	}
	s.residentState.mu.Lock()
	if s.draining.Load() {
		s.residentState.mu.Unlock()
		http.Error(w, "communicator draining", http.StatusServiceUnavailable)
		return
	}
	lease := r.URL.Path == "/_comm/lease"
	legacy := lease && r.Header.Get("X-CXX-Runtime-Protocol") != "1"
	if legacy {
		s.residentState.legacyClients++
	} else if !lease {
		s.residentState.pending++
	}
	s.residentState.mu.Unlock()
	defer func() {
		s.residentState.mu.Lock()
		if legacy {
			s.residentState.legacyClients--
		} else if !lease {
			s.residentState.pending--
		}
		s.residentState.mu.Unlock()
	}()
	s.ServeHTTP(w, r)
}

func (s *server) residentView() map[string]any {
	if s.residentState == nil {
		return map[string]any{"mode": "on_demand", "runtime_protocol": 0, "owner_instance_id": processInstance}
	}
	state := s.residentState
	state.mu.Lock()
	defer state.mu.Unlock()
	view := map[string]any{"mode": "resident", "runtime_protocol": residency.Protocol, "owner_instance_id": processInstance, "resident_enabled": state.policy.ResidentEnabled, "execution_enabled": state.policy.executionEnabled(), "resident_error": state.lastError, "binary_sha256": processExecutableDigest(), "managed": state.managed, "draining": s.draining.Load()}
	if !state.managed || !s.resident.Load() {
		view["mode"] = "on_demand"
	}
	if state.controller != nil {
		view["execution"] = state.controller.Status()
	}
	return view
}

// preflightStop fences both execution and local admission before the quiet
// snapshot. A refusal restores local admission and never stops the process.
func (s *server) preflightStop() string {
	if s.residentState == nil {
		return ""
	}
	state := s.residentState
	state.mu.Lock()
	defer state.mu.Unlock()
	wasDraining := s.draining.Swap(true)
	wasFenced := state.controller != nil && state.controller.Status().Fenced
	resume := func() {
		if !wasFenced {
			if resumable, ok := state.controller.(interface{ ResumeAdmission() }); ok {
				resumable.ResumeAdmission()
			}
		}
	}
	refuse := func(reason string) string {
		s.draining.Store(wasDraining)
		// The scheduler may have observed the temporary admission fence and
		// disarmed its timer. A refused handoff must restore that schedule too.
		if !wasDraining {
			select {
			case s.authDirty <- struct{}{}:
			default:
			}
		}
		return reason
	}
	if state.pending != 0 || state.legacyClients != 0 {
		return refuse("clients_busy")
	}
	if state.controller != nil {
		state.controller.Fence()
		status := state.controller.Status()
		if !status.Verified || !status.Workload.Quiet() {
			resume()
			return refuse("execution_busy")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.syncCalls) != 0 {
		if state.controller != nil {
			resume()
		}
		return refuse("sync_busy")
	}
	for _, scope := range s.scopes {
		if scope.running || len(scope.gate) != 0 {
			if state.controller != nil {
				resume()
			}
			return refuse("sync_busy")
		}
	}
	return ""
}

func (s *server) handoff(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "handoff requires POST", http.StatusMethodNotAllowed)
		return
	}
	if s.residentState == nil {
		http.Error(w, "owner does not support safe handoff", http.StatusConflict)
		return
	}
	var request struct {
		RequestID       string `json:"request_id"`
		OwnerInstanceID string `json:"owner_instance_id"`
		Command         string `json:"command,omitempty"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 2048))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid handoff request", http.StatusBadRequest)
		return
	}
	if _, err := uuid.Parse(request.RequestID); err != nil {
		http.Error(w, "invalid handoff request identity", http.StatusBadRequest)
		return
	}
	if request.Command != "" && request.Command != "prepare" && request.Command != "commit" {
		http.Error(w, "invalid handoff command", http.StatusBadRequest)
		return
	}
	if request.OwnerInstanceID != processInstance {
		http.Error(w, "handoff owner mismatch", http.StatusConflict)
		return
	}
	state := s.residentState
	state.mu.Lock()
	existing := state.handoffID
	if existing != "" && existing != request.RequestID {
		state.mu.Unlock()
		http.Error(w, "another handoff is pending", http.StatusConflict)
		return
	}
	if state.handoffChecking {
		state.mu.Unlock()
		http.Error(w, "handoff check is pending", http.StatusConflict)
		return
	}
	ready := state.handoffReady
	if !ready {
		state.handoffID = request.RequestID
		state.handoffChecking = true
	}
	state.mu.Unlock()
	if !ready {
		if reason := s.preflightStop(); reason != "" {
			state.mu.Lock()
			state.handoffID = ""
			state.handoffChecking = false
			state.mu.Unlock()
			http.Error(w, reason, http.StatusConflict)
			return
		}
	}
	state.mu.Lock()
	state.handoffID = request.RequestID
	state.handoffChecking = false
	state.handoffReady = true
	state.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"accepted": true, "request_id": request.RequestID, "owner_instance_id": processInstance})
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	if request.Command != "prepare" {
		acked := make(chan struct{})
		close(acked)
		s.terminate("resident handoff", acked)
	}
}

func (s *server) signalResidentPolicy() {
	if s.residentWake == nil {
		return
	}
	select {
	case s.residentWake <- struct{}{}:
	default:
	}
}
func (s *server) residentLoop(ctx context.Context) {
	state := s.residentState
	for {
		cfg := s.configSnapshot()
		work, cancel := context.WithTimeout(ctx, 10*time.Second)
		transport := s.residentTransport()
		s.mu.Lock()
		connected := s.conn != nil && !s.fallback
		s.mu.Unlock()
		var direct *http.Transport
		if !connected {
			var err error
			direct, err = directTransport(cfg)
			if err != nil {
				state.mu.Lock()
				state.lastError = "Resident settings transport unavailable"
				state.mu.Unlock()
				cancel()
				select {
				case <-ctx.Done():
					return
				case <-time.After(30 * time.Second):
				}
				continue
			}
			transport = direct
		}
		client := &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: httpguard.Redirect}
		req, _ := http.NewRequestWithContext(work, "GET", strings.TrimRight(cfg.Orchestrator.BaseURL, "/")+"/host/daemon/config", nil)
		req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
		res, err := client.Do(req)
		var policy residentPolicy
		if err == nil {
			if res.StatusCode != 200 {
				err = errors.New("resident settings unavailable")
			} else {
				err = httpguard.Decode(res.Body, 65536, &policy)
			}
			res.Body.Close()
		}
		cancel()
		if direct != nil {
			direct.CloseIdleConnections()
		}
		state.mu.Lock()
		if err != nil {
			state.lastError = "Resident settings unavailable; retrying"
		} else if policy.Username != communicatorUsername() {
			state.lastError = "Resident service user differs from configured user"
			policy.Enabled = false
			policy.ResidentEnabled = false
		} else {
			state.policy = policy
			state.lastError = ""
		}
		signed := cfg.Orchestrator.CommunicatorRuntimeProtocol == residency.Protocol
		if err == nil && (!signed || !policy.executionEnabled()) && state.controller != nil {
			state.controller.Fence()
		}
		if err == nil && signed && policy.executionEnabled() && !s.draining.Load() {
			if state.controller == nil || !state.controller.Status().Running && state.controller.Status().Verified && state.controller.Status().Workload.Quiet() {
				controller := state.options.Controller()
				state.controller = controller
				executionCtx, stop := context.WithCancel(ctx)
				state.cancelExecution = stop
				state.work.Add(1)
				go func() {
					defer state.work.Done()
					defer s.signalResidentPolicy()
					_ = controller.Run(executionCtx, residentExecutionTransport{s})
				}()
			}
		}
		if err == nil && (!signed || !policy.executionEnabled()) && state.controller != nil {
			status := state.controller.Status()
			if status.Verified && status.Workload.Quiet() && state.cancelExecution != nil {
				state.cancelExecution()
			}
		}
		keep := err != nil || signed && (state.policy.ResidentEnabled || state.policy.executionEnabled() || state.policy.ExecutionRequested)
		if state.controller != nil {
			status := state.controller.Status()
			keep = keep || !status.Verified || !status.Workload.Quiet()
		}
		s.resident.Store(keep)
		state.mu.Unlock()
		if err == nil && signed && keep {
			s.refreshResidentScopes()
		} else if err == nil {
			s.mu.Lock()
			for id := range s.jobs {
				if strings.HasPrefix(id, "resident/") {
					delete(s.jobs, id)
				}
			}
			s.mu.Unlock()
		}
		// Successful idle policy lives until a push/reconnect or its actual expiry.
		// Retry only failures and the drain of real execution work.
		var wake <-chan time.Time
		var timer *time.Timer
		delay := time.Duration(0)
		if err != nil {
			delay = 30 * time.Second
		} else if policy.ExpiresAt != "" {
			if expiry, parseErr := time.Parse(time.RFC3339Nano, policy.ExpiresAt); parseErr == nil && time.Until(expiry) > 0 {
				delay = time.Until(expiry)
			}
		}
		state.mu.Lock()
		if state.controller != nil && !policy.executionEnabled() {
			status := state.controller.Status()
			if !status.Verified || !status.Workload.Quiet() {
				delay = time.Second
			}
		}
		state.mu.Unlock()
		if delay > 0 {
			timer = time.NewTimer(delay)
			wake = timer.C
		}
		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return
		case <-s.residentWake:
		case <-wake:
		}
		if timer != nil {
			timer.Stop()
		}
	}
}

func (s *server) refreshResidentScopes() {
	key, err := signing.PublicKey()
	if err != nil {
		return
	}
	anchor := s.configSnapshot()
	wanted := map[string]syncJob{}
	for _, engine := range []string{"codex", "claude", "grok"} {
		path, err := config.DefaultPathForEngine(engine)
		if err != nil {
			continue
		}
		cfg, err := config.LoadForEngine(path, key, false, engine)
		if err != nil || cfg.EngineSuspended(engine) || cfg.Orchestrator.CommunicatorSyncProtocol != SyncProtocol || (cfg.Host.ID != anchor.Host.ID || cfg.Host.FQDN != anchor.Host.FQDN || strings.TrimRight(cfg.Orchestrator.BaseURL, "/") != strings.TrimRight(anchor.Orchestrator.BaseURL, "/") || cfg.Orchestrator.InstallationID != anchor.Orchestrator.InstallationID) {
			continue
		}
		env := map[string]string{}
		for _, name := range syncEnvKeys {
			if value, ok := os.LookupEnv(name); ok {
				env[name] = value
			}
		}
		job := syncJob{Owner: true, Engine: engine, Config: cfg.SourcePath(), Env: env}
		wanted["resident/"+engine] = job
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.jobs {
		if strings.HasPrefix(id, "resident/") {
			delete(s.jobs, id)
		}
	}
	for id, job := range wanted {
		s.jobs[id] = job
		s.stateLocked(job)
	}
}

// HTTP traffic remains under this owner's route/auth machinery without entering
// endpoint.ensure or holding a self lease that would defeat idle shutdown.
func (s *server) residentTransport() http.RoundTripper {
	return &residentHTTPTransport{s: s, local: unixClient(s.residentState.socket, 0).Transport}
}

type residentHTTPTransport struct {
	s      *server
	local  http.RoundTripper
	direct http.RoundTripper
}

func (t *residentHTTPTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := strings.TrimRight(t.s.configSnapshot().Orchestrator.BaseURL, "/")
	if req.URL.String() != base && !strings.HasPrefix(req.URL.String(), base+"/") {
		if t.direct == nil {
			return nil, errors.New("resident request outside configured server")
		}
		return t.direct.RoundTrip(req)
	}
	local := req.Clone(req.Context())
	local.URL.Scheme = "http"
	local.URL.Host = "communicator.local"
	local.Host = "communicator.local"
	local.Header = local.Header.Clone()
	local.Header.Set("X-CXX-Internal-Resident", "1")
	origin, _ := url.Parse(base)
	local.URL.Path = strings.TrimPrefix(req.URL.Path, strings.TrimRight(origin.Path, "/"))
	return t.local.RoundTrip(local)
}

type residentExecutionTransport struct{ s *server }

func (t residentExecutionTransport) Wrap(_ string, direct http.RoundTripper) http.RoundTripper {
	return &residentHTTPTransport{s: t.s, local: unixClient(t.s.residentState.socket, 0).Transport, direct: direct}
}
func (t residentExecutionTransport) OpenDaemon(ctx context.Context, base string) (residency.DaemonStream, error) {
	cfg := t.s.configSnapshot()
	if strings.TrimRight(base, "/") != strings.TrimRight(cfg.Orchestrator.BaseURL, "/") {
		return nil, errors.New("resident daemon server mismatch")
	}
	if cfg.Orchestrator.CommunicatorProtocol != Protocol {
		return t.s.residentState.options.DirectDaemon(ctx, base)
	}
	c := t.s.waitConnection(ctx)
	if c == nil {
		return nil, errors.New("resident daemon control connection unavailable")
	}
	channel := make(chan json.RawMessage, 64)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.daemon != nil || c.daemonClosing != nil {
		return nil, errors.New("daemon stream already attached")
	}
	streamCtx, stop := context.WithCancel(ctx)
	c.daemon = channel
	c.daemonStop = stop
	return &residentDaemonStream{c: c, channel: channel, ctx: streamCtx, stop: stop}, nil
}

type residentDaemonStream struct {
	c       *connection
	channel chan json.RawMessage
	ctx     context.Context
	stop    context.CancelFunc
	once    sync.Once
}

func (s *residentDaemonStream) Send(value any) error {
	return s.c.send(map[string]any{"type": "daemon", "payload": value})
}
func (s *residentDaemonStream) Receive(value any) error {
	select {
	case <-s.ctx.Done():
		return s.ctx.Err()
	case <-s.c.done:
		return io.EOF
	case raw, ok := <-s.channel:
		if !ok || len(raw) == 0 {
			return io.EOF
		}
		return json.Unmarshal(raw, value)
	}
}
func (s *residentDaemonStream) Close() error {
	s.once.Do(func() { s.stop(); s.c.detachDaemon(s.channel); s.c.finishDaemon(s.channel) })
	return nil
}

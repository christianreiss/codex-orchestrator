package communicator

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	"github.com/fsnotify/fsnotify"
)

type syncJob struct {
	Owner     bool              `json:"owner,omitempty"`
	Engine    string            `json:"engine"`
	Config    string            `json:"config"`
	Env       map[string]string `json:"env"`
	Auth      bool              `json:"auth,omitempty"`
	AuthPath  string            `json:"auth_path,omitempty"`
	AccountID int64             `json:"account_id,omitempty"`
	SessionID string            `json:"session_id,omitempty"`
	Broker    string            `json:"broker,omitempty"`
}

type AuthStatus struct {
	HostStatus     string `json:"host_status,omitempty"`
	Type           string `json:"type"`
	Scope          string `json:"scope"`
	Engine         string `json:"engine"`
	AccountID      int64  `json:"account_id,omitempty"`
	Generation     string `json:"generation,omitempty"`
	State          string `json:"state"`
	NativeAdoption string `json:"native_adoption"`
	UpdatedAt      string `json:"updated_at,omitempty"`
	Error          string `json:"error,omitempty"`
	HostSecure     *bool  `json:"host_secure,omitempty"`
	Fatal          bool   `json:"fatal,omitempty"`
}
type scopeState struct {
	gate         chan struct{}
	auth         AuthStatus
	lastFile     string
	nextAuth     time.Time
	nextContent  time.Time
	retryDelay   time.Duration
	lastUsed     time.Time
	running      bool
	contentError string
	localError   string
}

var syncEnvKeys = []string{"HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CDX_CONFIG_PATH", "CLX_CONFIG_PATH", "CGX_CONFIG_PATH"}

func RegisterSync(engine string) {
	if os.Getenv("CXX_COMMUNICATOR_SYNC") == "1" {
		return
	}
	path, err := config.DefaultPathForEngine(engine)
	if err != nil {
		return
	}
	key, err := signing.PublicKey()
	if err != nil {
		return
	}
	cfg, err := config.LoadForEngine(path, key, false, engine)
	if err != nil {
		return
	}
	ep := endpointFor(cfg.Orchestrator.BaseURL)
	if ep == nil {
		return
	}
	job, err := newSyncJob(context.Background(), cfg.Orchestrator.BaseURL, engine, "")
	if err != nil {
		return
	}
	ep.mu.Lock()
	defer ep.mu.Unlock()
	if ep.jobs == nil {
		ep.jobs = map[string]syncJob{}
	}
	ep.jobs[engine] = job
}
func jobHome(job syncJob) string {
	home := job.Env["HOME"]
	switch job.Engine {
	case "codex":
		if h := job.Env["CODEX_HOME"]; h != "" {
			return h
		}
		return filepath.Join(home, ".codex")
	case "claude":
		return filepath.Join(home, ".claude") // authoritative native source, matching claude.AuthPath
	case "grok":
		if h := job.Env["GROK_HOME"]; h != "" {
			return h
		}
		return filepath.Join(home, ".grok")
	}
	return ""
}
func canonicalPath(path string) string {
	path, _ = filepath.Abs(path)
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	// Resolve existing parents even before the native directory is provisioned.
	parent := filepath.Dir(path)
	if parent != path {
		return filepath.Join(canonicalPath(parent), filepath.Base(path))
	}
	return filepath.Clean(path)
}
func scopeID(job syncJob) string {
	raw := job.Engine + "\x00" + canonicalPath(jobHome(job))
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
func jobID(job syncJob) string {
	raw, _ := json.Marshal(job)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func validateJob(job syncJob) error {
	if job.Engine != "codex" && job.Engine != "claude" && job.Engine != "grok" {
		return errors.New("invalid engine")
	}
	if !filepath.IsAbs(job.Config) || !filepath.IsAbs(job.Env["HOME"]) || !filepath.IsAbs(jobHome(job)) {
		return errors.New("sync paths must be absolute")
	}
	for key := range job.Env {
		found := false
		for _, allowed := range syncEnvKeys {
			if key == allowed {
				found = true
			}
		}
		if !found {
			return errors.New("invalid sync environment")
		}
	}
	if job.AuthPath != "" {
		want := filepath.Join(jobHome(job), "auth.json")
		if job.Engine == "claude" {
			want = filepath.Join(jobHome(job), ".credentials.json")
		}
		if canonicalPath(job.AuthPath) != canonicalPath(want) {
			return errors.New("auth source does not match native home")
		}
	}
	if job.Auth && job.Engine != "grok" && job.AuthPath == "" {
		return errors.New("auth scope missing native source")
	}
	if job.Broker != "" && (job.Engine != "grok" || !filepath.IsAbs(job.Broker)) {
		return errors.New("invalid runtime broker")
	}
	return nil
}

// registerJobs records a lease's scopes. fresh reports whether any of them is
// new to this owner: only a new scope needs an initial pass. An extra lease on
// a scope that is already current must not force every scope's auth and
// content work in front of the launching session's own bootstrap.
func (s *server) registerJobs(r *http.Request) (ids []string, fresh bool, err error) {
	var jobs []syncJob
	if err := json.NewDecoder(io.LimitReader(r.Body, 65536)).Decode(&jobs); err != nil {
		return nil, false, err
	}
	if len(jobs) > 3 {
		return nil, false, errors.New("too many sync scopes")
	}
	for _, job := range jobs {
		if err := validateJob(job); err != nil {
			return nil, false, err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ids = make([]string, 0, len(jobs))
	for _, job := range jobs {
		id := jobID(job)
		ids = append(ids, id)
		s.jobs[id] = job
		s.jobRefs[id]++
		if s.scopes == nil || s.scopes[stateID(job)] == nil {
			fresh = true
		}
		s.stateLocked(job)
	}
	return ids, fresh, nil
}
func (s *server) stateLocked(job syncJob) *scopeState {
	if s.scopes == nil {
		s.scopes = map[string]*scopeState{}
	}
	id := stateID(job)
	state := s.scopes[id]
	if state == nil {
		state = &scopeState{gate: make(chan struct{}, 1), auth: AuthStatus{Type: "auth_state", Scope: id, Engine: job.Engine, State: "pending", NativeAdoption: "unknown"}}
		s.scopes[id] = state
	}
	state.lastUsed = time.Now()
	return state
}

func (s *server) syncHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	var in SyncRequest
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in) != nil || validateJob(in.Job) != nil {
		http.Error(w, "invalid sync request", 400)
		return
	}
	switch in.Operation {
	case "bootstrap", "content", "auth", "skills":
	default:
		http.Error(w, "invalid sync operation", 400)
		return
	}
	out := s.runSync(r.Context(), in)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// Every worker is finite and side-effect-limited. Environment isolation keeps
// concurrent home/account scopes independent without mutating daemon globals.
type syncCall struct {
	done   chan struct{}
	result SyncResult
}

func (s *server) runSync(ctx context.Context, in SyncRequest) SyncResult {
	if in.Operation == "auth" || in.IncludeAuth {
		return s.executeSync(ctx, in)
	}
	keyRequest := in
	keyRequest.Job.Auth = false
	keyRequest.Job.AuthPath = ""
	keyRequest.Job.AccountID = 0
	keyRequest.Job.SessionID = ""
	keyRequest.Job.Broker = ""
	raw, _ := json.Marshal(keyRequest)
	key := string(raw)
	s.mu.Lock()
	if s.syncCalls == nil {
		s.syncCalls = map[string]*syncCall{}
	}
	if existing := s.syncCalls[key]; existing != nil {
		s.shared++
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return syncFailure(ctx.Err())
		case <-existing.done:
			return existing.result
		}
	}
	call := &syncCall{done: make(chan struct{})}
	s.syncCalls[key] = call
	s.mu.Unlock()
	go func() {
		work, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		call.result = s.executeSync(work, in)
		s.mu.Lock()
		delete(s.syncCalls, key)
		close(call.done)
		s.mu.Unlock()
	}()
	select {
	case <-ctx.Done():
		return syncFailure(ctx.Err())
	case <-call.done:
		return call.result
	}
}
func (s *server) executeSync(ctx context.Context, in SyncRequest) (out SyncResult) {
	s.mu.Lock()
	state := s.stateLocked(in.Job)
	s.active++
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.active--; s.lastUsed = time.Now(); s.mu.Unlock() }()
	select {
	case state.gate <- struct{}{}:
	case <-ctx.Done():
		return syncFailure(ctx.Err())
	}
	defer func() { <-state.gate }()
	defer func() {
		if out.Error != nil {
			s.mu.Lock()
			state.localError = out.Error.Message
			if in.Operation == "auth" {
				state.auth.State = "error"
				state.auth.Error = "Auth synchronization failed; inspect local doctor"
			} else {
				state.contentError = "Content synchronization failed"
			}
			s.mu.Unlock()
		}
	}()
	key, err := signing.PublicKey()
	if err != nil {
		return syncFailure(err)
	}
	cfg, err := config.LoadForEngine(in.Job.Config, key, false, in.Job.Engine)
	if err != nil {
		return syncFailure(err)
	}
	seed := s.configSnapshot()
	if strings.TrimRight(cfg.Orchestrator.BaseURL, "/") != strings.TrimRight(seed.Orchestrator.BaseURL, "/") || cfg.Host.ID != seed.Host.ID {
		return syncFailure(errors.New("sync scope belongs to another host or server"))
	}
	// A signed capability rollback is applied only between finite operations.
	// Dedicated workers remain the sole writers while clients drain their leases.
	exe, err := os.Executable()
	if err != nil {
		return syncFailure(err)
	}
	timeout := 90 * time.Second
	if in.Operation == "auth" {
		timeout = 15 * time.Second
	}
	work, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(work, exe, "communicator-worker")
	env := communicatorEnvironment(os.Environ())
	for _, prefix := range append(append([]string{}, syncEnvKeys...), "CXX_PROVIDER_ACCOUNT_ID", "CXX_PROVIDER_SESSION_ID", "CXX_COMMUNICATOR_SYNC") {
		for i := len(env) - 1; i >= 0; i-- {
			if strings.HasPrefix(env[i], prefix+"=") {
				env = append(env[:i], env[i+1:]...)
			}
		}
	}
	for k, v := range in.Job.Env {
		env = append(env, k+"="+v)
	}
	cmd.Env = append(env, "CXX_COMMUNICATOR_SYNC=1")
	raw, _ := json.Marshal(in)
	cmd.Stdin = bytes.NewReader(raw)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return syncFailure(fmt.Errorf("sync worker failed: %w", err))
	}
	if err := json.Unmarshal(output.Bytes(), &out); err != nil {
		return syncFailure(errors.New("invalid sync worker response"))
	}
	s.mu.Lock()
	if in.Operation == "auth" || state.auth.State != "error" {
		state.localError = ""
	}
	if in.Operation == "auth" {
		state.auth.AccountID = in.Job.AccountID
		state.auth.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if out.Generation != "" {
			state.auth.Generation = out.Generation
		}
		state.auth.HostStatus = out.HostStatus
		state.auth.HostSecure = out.HostSecure
		state.auth.Error = ""
		state.auth.Fatal = false
		switch {
		case out.Error != nil:
			state.auth.State = "error"
			state.auth.Error = "Auth synchronization failed; inspect local doctor"
			var h struct {
				StatusCode int
				Code       string
			}
			_ = json.Unmarshal(out.Error.HTTP, &h)
			state.auth.Fatal = in.Job.Engine == "grok" && (h.StatusCode == 401 || h.StatusCode == 404 || h.StatusCode == 409)
		case out.Deferred:
			state.auth.State = "deferred"
		case out.Adopted:
			state.auth.State = "locally_written"
			state.auth.NativeAdoption = "pending"
		case out.Uploaded:
			state.auth.State = "server_confirmed"
		default:
			state.auth.State = "checked"
		}
	} else {
		state.contentError = ""
		if out.Error != nil {
			state.contentError = "Content synchronization failed"
		}
		for _, r := range out.Resources {
			if r.Error != "" {
				state.contentError = "Content synchronization incomplete"
			}
		}
		if state.contentError == "" {
			s.lastSync = time.Now().UTC().Format(time.RFC3339)
		}
	}
	s.mu.Unlock()
	return out
}
func syncFailure(err error) SyncResult { return SyncResult{Error: &SyncError{Message: err.Error()}} }

func fileGeneration(path string) string {
	if path == "" {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (s *server) syncLoop(ctx context.Context) {
	poll := time.NewTicker(2 * time.Second)
	defer poll.Stop()
	watcher, _ := fsnotify.NewWatcher()
	if watcher != nil {
		defer watcher.Close()
	}
	var events <-chan fsnotify.Event
	var watchErrors <-chan error
	if watcher != nil {
		events, watchErrors = watcher.Events, watcher.Errors
	}
	watched := map[string]bool{}
	var work sync.WaitGroup
	defer work.Wait()
	for {
		force := false
		select {
		case <-ctx.Done():
			return
		case <-poll.C:
		case <-s.dirty:
			force = true
		case <-s.authDirty:
		case <-events:
		case <-watchErrors:
		}
		s.mu.Lock()
		jobs := map[string]syncJob{}
		// Choose a stable live session for a shared native source. A private Grok
		// runtime is a separate readiness consumer, never a canonical uploader.
		keys := make([]string, 0, len(s.jobs))
		for k := range s.jobs {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			job := s.jobs[k]
			id := scopeID(job)
			if job.Engine == "grok" && job.Auth {
				id += "/" + job.Broker
			}
			prev, ok := jobs[id]
			if !ok || (job.Auth && !prev.Auth) {
				jobs[id] = job
			}
		}
		live := map[string]bool{}
		for _, job := range jobs {
			live[stateID(job)] = true
		}
		for id, state := range s.scopes {
			if !live[id] && !state.running && len(state.gate) == 0 && time.Since(state.lastUsed) > 5*time.Minute {
				delete(s.scopes, id)
			}
		}
		connected := s.conn != nil || s.fallback
		s.mu.Unlock()
		if !connected {
			continue
		}
		for _, job := range jobs {
			if job.Owner && job.Auth && signedSyncDisabled(job) {
				continue
			}
			if watcher != nil && job.AuthPath != "" {
				dir := filepath.Dir(job.AuthPath)
				if !watched[dir] && watcher.Add(dir) == nil {
					watched[dir] = true
				}
			}
			digest := ""
			if job.Auth {
				digest = fileGeneration(job.AuthPath)
			}
			s.mu.Lock()
			state := s.stateLocked(job)
			if force {
				state.nextAuth = time.Time{}
				state.nextContent = time.Time{}
			}
			authDue := job.Auth && (time.Now().After(state.nextAuth) || digest != state.lastFile)
			contentDue := time.Now().After(state.nextContent)
			if state.running || (!authDue && !contentDue) {
				s.mu.Unlock()
				continue
			}
			state.running = true
			// Schedule before dispatch; invalidations arriving during work reset this
			// deadline and cause another pass, never disappear behind an in-flight flag.
			if authDue {
				state.nextAuth = time.Now().Add(30 * time.Second)
				state.lastFile = digest
			}
			if contentDue {
				state.nextContent = time.Now().Add(5 * time.Minute)
			}
			s.mu.Unlock()
			work.Add(1)
			go func(job syncJob, state *scopeState, authDue, contentDue bool) {
				defer work.Done()
				defer func() { s.mu.Lock(); state.running = false; s.mu.Unlock() }()
				if authDue {
					result := s.runSync(ctx, SyncRequest{Job: job, Operation: "auth"})
					s.mu.Lock()
					if result.Error != nil {
						state.retryDelay *= 2
						if state.retryDelay == 0 {
							state.retryDelay = 5 * time.Second
						}
						if state.retryDelay > time.Minute {
							state.retryDelay = time.Minute
						}
						// Preserve an invalidation received during this attempt.
						if !state.nextAuth.IsZero() {
							state.nextAuth = time.Now().Add(state.retryDelay)
						}
					} else {
						state.retryDelay = 0
					}
					s.mu.Unlock()
				}
				if contentDue && !(job.Owner && signedSyncDisabled(job)) {
					s.runSync(ctx, SyncRequest{Job: job, Operation: "content"})
				}
			}(job, state, authDue, contentDue)
		}
	}
}

func (s *server) scopeViewsLocked() []map[string]any {
	views := []map[string]any{}
	for id, state := range s.scopes {
		views = append(views, map[string]any{"scope": id, "auth": state.auth, "running": state.running || len(state.gate) > 0, "content_error": state.contentError})
	}
	return views
}

func stateID(job syncJob) string {
	id := scopeID(job)
	if job.Engine == "grok" && job.Auth {
		sum := sha256.Sum256([]byte(job.Broker))
		id += "/" + hex.EncodeToString(sum[:8])
	}
	return id
}

// wake runs the scheduler now without forcing any scope. A newly registered
// scope starts with zero deadlines and is due on its own; unrelated scopes keep
// their schedules (a fresh per-session Grok runtime scope must not resync the
// warm Codex/Claude scopes in front of a launch).
func (s *server) wake() {
	select {
	case s.authDirty <- struct{}{}:
	default:
	}
}

func (s *server) invalidateAuth(engine string, account int64) {
	s.mu.Lock()
	for _, state := range s.scopes {
		if (engine == "" || state.auth.Engine == engine) && (account == 0 || state.auth.AccountID == account) {
			state.nextAuth = time.Time{}
		}
	}
	s.mu.Unlock()
	// The two-second reconciliation tick is a fallback; notify the scheduler now
	// without resetting unrelated managed-content deadlines.
	select {
	case s.authDirty <- struct{}{}:
	default:
	}
}

func signedSyncDisabled(job syncJob) bool {
	key, err := signing.PublicKey()
	if err != nil {
		return false
	}
	cfg, err := config.LoadForEngine(job.Config, key, false, job.Engine)
	return err == nil && (cfg.Orchestrator.CommunicatorProtocol != Protocol || cfg.Orchestrator.CommunicatorSyncProtocol != SyncProtocol)
}

// Detailed failures stay on the private local socket. Remote diagnostics use
// only the bounded metadata view and never forward provider error bodies.
func (s *server) localErrorsLocked() map[string]string {
	result := map[string]string{}
	for id, state := range s.scopes {
		if state.localError != "" {
			result[id] = state.localError
		}
	}
	return result
}

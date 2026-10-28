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
	suspended bool
	gate      chan struct{}
	// authGate serializes credential work for the scope. Content-only work holds
	// gate, an auth-only bootstrap holds authGate, and anything that does both
	// takes gate then authGate, so a warm-cache launch never queues behind a
	// background content pass.
	authGate     chan struct{}
	auth         AuthStatus
	lastFile     string
	nextAuth     time.Time
	nextContent  time.Time
	retryDelay   time.Duration
	lastUsed     time.Time
	running      bool
	contentError string
	localError   string
	// contentFresh is when the newest completed bootstrap/content worker for this
	// scope STARTED. A worker that started after the server's last invalidation
	// (server.invalidatedAt) read state no older than anything the scheduler could
	// still be waiting to learn.
	contentFresh time.Time
	born         time.Time
}

// contentPeriod is the periodic reconciliation interval of a scope's content.
const contentPeriod = 5 * time.Minute

// initialContentGrace holds back a new scope's first scheduled content pass. The
// session that registered the scope runs its own bootstrap within milliseconds;
// scheduling the pass first would make that bootstrap repeat it behind the gate.
// An invalidation, or a scope nobody bootstraps, is never held longer than this
// plus one scheduler tick.
const initialContentGrace = 1500 * time.Millisecond

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
		if job.Auth {
			observed := false
			for _, prior := range s.jobs {
				if prior.Auth && stateID(prior) == stateID(job) {
					observed = true
					break
				}
			}
			if !observed {
				fresh = true
			}
		}
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
		state = &scopeState{gate: make(chan struct{}, 1), authGate: make(chan struct{}, 1), born: time.Now(), auth: AuthStatus{Type: "auth_state", Scope: id, Engine: job.Engine, State: "pending", NativeAdoption: "unknown"}}
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
	case "bootstrap", "content", "auth", "skills", "primed":
	default:
		http.Error(w, "invalid sync operation", 400)
		return
	}
	if in.SkipContent && (in.Operation != "bootstrap" || !in.IncludeAuth) {
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

// coalesceKey names the exchange a content request would perform. Scheduler
// passes are keyed apart from explicit callers: a scheduled pass can be
// satisfied without any exchange, and an explicit caller that joined it would
// be handed that empty result instead of the resources it asked for.
func coalesceKey(in SyncRequest) string {
	keyRequest := in
	keyRequest.Job.Auth = false
	keyRequest.Job.AuthPath = ""
	keyRequest.Job.AccountID = 0
	keyRequest.Job.SessionID = ""
	keyRequest.Job.Broker = ""
	raw, _ := json.Marshal(keyRequest)
	if in.Scheduled {
		return "scheduled\x00" + string(raw)
	}
	return string(raw)
}

func (s *server) runSync(ctx context.Context, in SyncRequest) SyncResult {
	if in.Operation == "primed" {
		s.mu.Lock()
		defer s.mu.Unlock()
		return SyncResult{Primed: s.primedLocked(scopeID(in.Job))}
	}
	if in.Operation == "auth" || in.IncludeAuth {
		out := s.executeSync(ctx, in)
		if in.Operation == "auth" {
			out = s.confirmGrokNotFound(ctx, in, out, s.executeSync)
		}
		return out
	}
	key := coalesceKey(in)
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

// authWorkerTimeout bounds a credential sync worker. Anything it waits on, notably the
// control connection (connectWaitFirst), must give an answer well before this.
const authWorkerTimeout = 15 * time.Second

// authResyncEvery is the safety net between pushed auth_changed frames and
// reconnects, which re-run an auth job at once. Every session's job ran every
// 30 s (/auth, the costliest host route, about 0.5 requests/s, 2026-10-23).
const authResyncEvery = 5 * time.Minute

func (s *server) executeSync(ctx context.Context, in SyncRequest) (out SyncResult) {
	s.mu.Lock()
	state := s.stateLocked(in.Job)
	s.active++
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.active--; s.lastUsed = time.Now(); s.mu.Unlock() }()
	contentLock, authLock := syncLocks(in)
	if contentLock {
		select {
		case state.gate <- struct{}{}:
		case <-ctx.Done():
			return syncFailure(ctx.Err())
		}
		defer func() { <-state.gate }()
	}
	if authLock {
		select {
		case state.authGate <- struct{}{}:
		case <-ctx.Done():
			return syncFailure(ctx.Err())
		}
		defer func() { <-state.authGate }()
	}
	if in.Scheduled && in.Operation == "content" {
		// A launch's own bootstrap normally completes the scope's initial pass while
		// the scheduler's pass for the same new scope waits on this gate. Running the
		// identical exchange again only delays every operation queued behind it.
		s.mu.Lock()
		satisfied := !state.contentFresh.IsZero() && state.contentFresh.After(s.invalidatedAt) && time.Since(state.contentFresh) < contentPeriod
		if satisfied {
			// Reconcile again one period after the exchange that satisfied this pass.
			if due := state.contentFresh.Add(contentPeriod); state.nextContent.Before(due) {
				state.nextContent = due
			}
			s.mu.Unlock()
			return SyncResult{}
		}
		s.mu.Unlock()
	}
	defer s.notifyLocal()
	workerStart := time.Now()
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
		timeout = authWorkerTimeout
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
			// A 404 is not final here: confirmGrokNotFound re-checks it and sets
			// Fatal only if the lease still has no live provider attachment.
			state.auth.Fatal = in.Job.Engine == "grok" && revokedGrokAuth(out.Error.HTTP) && !grokSessionNotFound(out.Error.HTTP)
		case out.Deferred:
			state.auth.State = "deferred"
		case out.Adopted:
			state.auth.State = "locally_written"
			state.auth.NativeAdoption = "unconfirmed"
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
			if (in.Operation == "bootstrap" || in.Operation == "content") && !in.SkipContent && !in.ReconcileOnly && len(out.Resources) > 0 && !out.Deferred {
				state.contentFresh = workerStart
				// The scope stays primed until the next server invalidation.
				if s.primed == nil {
					s.primed = map[string]time.Time{}
				}
				if id := scopeID(in.Job); workerStart.After(s.primed[id]) {
					s.primed[id] = workerStart
				}
			}
		}
	}
	s.mu.Unlock()
	return out
}
func syncFailure(err error) SyncResult { return SyncResult{Error: &SyncError{Message: err.Error()}} }

// syncLocks names the scope locks an operation needs: content for managed files,
// auth for native credentials (and its pending marker). Lock order is always
// content before auth.
func syncLocks(in SyncRequest) (content, auth bool) {
	switch {
	case in.SkipContent:
		return false, true
	case in.Operation == "auth" || (in.Operation == "bootstrap" && in.IncludeAuth):
		return true, true
	default:
		return true, false
	}
}

// grokNotFoundRecheck is the production policy for confirmGrokNotFound.
var grokNotFoundRecheck RecheckPolicy

// grokSessionNotFound is the 404 class a lease answers while its provider
// attachment is redialing (see ConfirmNotFound).
func grokSessionNotFound(raw json.RawMessage) bool {
	var failure struct{ StatusCode int }
	return json.Unmarshal(raw, &failure) == nil && failure.StatusCode == 404
}

// syncResultError adapts a failed SyncResult to ConfirmNotFound.
type syncResultError struct{ result SyncResult }

func (e *syncResultError) Error() string { return e.result.Error.Message }

func isGrokSyncNotFound(err error) bool {
	var failed *syncResultError
	return errors.As(err, &failed) && failed.result.Error != nil && grokSessionNotFound(failed.result.Error.HTTP)
}

// confirmGrokNotFound runs after a Grok auth operation. A 404 is re-checked by
// repeating the operation; only a 404 that persists marks the auth Fatal
// (revoked). Any other answer replaces the result and is classified as before.
func (s *server) confirmGrokNotFound(ctx context.Context, in SyncRequest, out SyncResult, execute func(context.Context, SyncRequest) SyncResult) SyncResult {
	if in.Job.Engine != "grok" || out.Error == nil || !grokSessionNotFound(out.Error.HTTP) {
		return out
	}
	err := ConfirmNotFound(ctx, grokNotFoundRecheck, func(c context.Context) error {
		out = execute(c, in)
		if out.Error == nil {
			return nil
		}
		return &syncResultError{out}
	}, isGrokSyncNotFound)
	if err != nil && isGrokSyncNotFound(err) {
		s.mu.Lock()
		s.stateLocked(in.Job).auth.Fatal = true
		s.mu.Unlock()
		s.notifyLocal()
	}
	return out
}

func revokedGrokAuth(raw json.RawMessage) bool {
	var failure struct {
		StatusCode int
		Code       string
	}
	if json.Unmarshal(raw, &failure) != nil {
		return false
	}
	// A lost control reply is a transport uncertainty, not revoked credentials.
	return failure.StatusCode == 401 || failure.StatusCode == 404 ||
		(failure.StatusCode == 409 && failure.Code != "communicator_outcome_unknown")
}

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
	poll := time.NewTimer(0)
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
		watchComplete := watcher != nil
		s.mu.Lock()
		for _, job := range s.jobs {
			if job.AuthPath != "" && !watched[filepath.Dir(job.AuthPath)] {
				watchComplete = false
			}
			if job.Config != "" && !watched[filepath.Dir(job.Config)] {
				watchComplete = false
			}
		}
		s.mu.Unlock()
		if delay, scheduled := s.nextSyncWake(watchComplete); scheduled {
			poll.Reset(delay)
		} else {
			poll.Stop()
		}
		select {
		case <-ctx.Done():
			return
		case <-poll.C:
		case <-s.dirty:
			force = true
		case <-s.authDirty:
		case event := <-events:
			forgetReplacedWatch(watcher, watched, event)
			s.notifyLocal()
		case <-watchErrors:
			s.recoverWatchCoverage(watcher, watched)
		}
		if s.draining.Load() {
			continue
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
		stateOwned := false
		if s.conn != nil {
			s.conn.mu.Lock()
			stateOwned = s.conn.stateEnabled
			s.conn.mu.Unlock()
		}
		s.mu.Unlock()
		// Local signed policy can change while the upstream is unavailable.
		// Install watches before the network gate; they never force a DB refresh.
		if watcher != nil {
			pruneUnusedWatches(watcher, watched, jobs)
			for _, job := range jobs {
				for _, path := range []string{job.Config, job.AuthPath} {
					if path == "" {
						continue
					}
					dir := filepath.Dir(path)
					if !watched[dir] && watcher.Add(dir) == nil {
						watched[dir] = true
					}
				}
			}
		}
		if !connected {
			continue
		}
		// Content is per engine and native home. Grok runtime brokers sharing a
		// home are separate auth consumers but must not each repeat the content
		// exchange: one deterministic job per home schedules it.
		order := make([]string, 0, len(jobs))
		for id := range jobs {
			order = append(order, id)
		}
		sort.Strings(order)
		contentOwner := map[string]string{}
		for _, id := range order {
			if home := scopeID(jobs[id]); contentOwner[home] == "" {
				contentOwner[home] = id
			}
		}
		for _, id := range order {
			job := jobs[id]
			if job.Owner && job.Auth && signedSyncDisabled(job) {
				s.mu.Lock()
				s.stateLocked(job).suspended = true
				s.mu.Unlock()
				continue
			}
			if watcher != nil && job.Config != "" {
				dir := filepath.Dir(job.Config)
				if !watched[dir] && watcher.Add(dir) == nil {
					watched[dir] = true
				}
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
			state.suspended = false
			if s.draining.Load() {
				s.mu.Unlock()
				continue
			}
			if force {
				state.nextAuth = time.Time{}
				state.nextContent = time.Time{}
			}
			authDue := job.Auth && (time.Now().After(state.nextAuth) || digest != state.lastFile)
			contentDue := time.Now().After(state.nextContent) && contentOwner[scopeID(job)] == id
			if contentDue && !force && state.nextContent.IsZero() && state.contentFresh.IsZero() && time.Since(state.born) < initialContentGrace {
				contentDue = false
			}
			if state.running || (!authDue && !contentDue) {
				s.mu.Unlock()
				continue
			}
			state.running = true
			// Schedule before dispatch; invalidations arriving during work reset this
			// deadline and cause another pass, never disappear behind an in-flight flag.
			if authDue {
				state.nextAuth = time.Now().Add(authResyncEvery)
				if stateOwned {
					state.nextAuth = time.Now().Add(100 * 365 * 24 * time.Hour)
				}
				state.lastFile = digest
			}
			if contentDue {
				state.nextContent = time.Now().Add(5 * time.Minute)
				if stateOwned {
					state.nextContent = time.Now().Add(100 * 365 * 24 * time.Hour)
				}
			}
			s.mu.Unlock()
			work.Add(1)
			go func(job syncJob, state *scopeState, authDue, contentDue bool) {
				defer work.Done()
				defer func() { s.mu.Lock(); state.running = false; s.mu.Unlock(); s.wake() }()
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
					result := s.runSync(ctx, SyncRequest{Job: job, Operation: "content", Scheduled: true})
					if result.Error != nil {
						s.mu.Lock()
						if !state.nextContent.IsZero() {
							state.nextContent = time.Now().Add(15 * time.Second)
						}
						s.mu.Unlock()
					}
				}
			}(job, state, authDue, contentDue)
		}
	}
}

func (s *server) scopeViewsLocked() []map[string]any {
	views := []map[string]any{}
	for id, state := range s.scopes {
		home, _, _ := strings.Cut(id, "/")
		views = append(views, map[string]any{"scope": id, "auth": state.auth, "running": state.running || len(state.gate) > 0 || len(state.authGate) > 0, "content_error": state.contentError, "primed": s.primedLocked(home)})
	}
	sort.Slice(views, func(i, j int) bool { return views[i]["scope"].(string) < views[j]["scope"].(string) })
	return views
}

// primedLocked reports whether a home scope's content is current without an
// exchange: its newest complete content pass started after the newest server
// invalidation (a pushed frame or a reconnect, e.g. after a server deploy).
// Invalidations re-run content only for scopes with a live lease, so a scope
// nobody is attached to is left unprimed until a launch or explicit sync
// performs a full exchange again. s.mu must be held.
func (s *server) primedLocked(home string) bool {
	at, ok := s.primed[home]
	return ok && at.After(s.invalidatedAt)
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
	s.notifyLocal()
	select {
	case s.authDirty <- struct{}{}:
	default:
	}
}

func (s *server) invalidateAuth(engine string, account int64) {
	s.validatedCache.invalidateLocal()
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

// nextSyncWake replaces the fixed scanner with the earliest real retry/deadline.
// Platforms without a file watcher still inspect local files, without forcing
// successful auth/content scopes to query the owner again.
func (s *server) nextSyncWake(watching bool) (time.Duration, bool) {
	// Prepared handoffs deliberately retain their fences until journal recovery.
	// An overdue deadline cannot advance while draining; do not hot-loop on it.
	if s.draining.Load() {
		return 0, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil && !s.fallback {
		return 0, false
	}
	next := time.Time{}
	consider := func(at time.Time) {
		if at.IsZero() {
			at = time.Now()
		}
		if next.IsZero() || at.Before(next) {
			next = at
		}
	}
	if !watching {
		consider(time.Now().Add(2 * time.Second))
	}
	keys := make([]string, 0, len(s.jobs))
	for key := range s.jobs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	seen := map[string]bool{}
	for _, key := range keys {
		job := s.jobs[key]
		home := scopeID(job)
		content := !seen[home]
		seen[home] = true
		state := s.scopes[stateID(job)]
		if state == nil {
			consider(time.Now())
			continue
		}
		if state.running || state.suspended {
			continue
		}
		if job.Auth {
			consider(state.nextAuth)
		}
		if content {
			due := state.nextContent
			if due.IsZero() && state.contentFresh.IsZero() {
				due = state.born.Add(initialContentGrace)
			}
			consider(due)
		}
	}
	if next.IsZero() {
		return 0, false
	}
	delay := time.Until(next)
	if delay < 0 {
		delay = 0
	}
	return delay, true
}

// Directory watches follow inodes, not recreated pathnames. Forget coverage on
// replacement so the existing bounded fallback retries Add until the path exists.
func forgetReplacedWatch(watcher *fsnotify.Watcher, watched map[string]bool, event fsnotify.Event) {
	if watched[event.Name] && event.Has(fsnotify.Remove|fsnotify.Rename) {
		_ = watcher.Remove(event.Name)
		delete(watched, event.Name)
	}
}

func pruneUnusedWatches(watcher *fsnotify.Watcher, watched map[string]bool, jobs map[string]syncJob) {
	wanted := map[string]bool{}
	for _, job := range jobs {
		for _, path := range []string{job.Config, job.AuthPath} {
			if path != "" {
				wanted[filepath.Dir(path)] = true
			}
		}
	}
	for dir := range watched {
		if !wanted[dir] {
			_ = watcher.Remove(dir)
			delete(watched, dir)
		}
	}
}

// Overflow has no corresponding file event. Wake local lease observers as well
// as rebuilding watch coverage, so signed policy changes cannot strand a lease.
func (s *server) recoverWatchCoverage(watcher *fsnotify.Watcher, watched map[string]bool) {
	s.notifyLocal()
	for dir := range watched {
		_ = watcher.Remove(dir)
		delete(watched, dir)
	}
}

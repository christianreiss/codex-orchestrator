package communicator

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
)

const SyncProtocol = 1

// CacheProtocol is the signed warm-cache launch capability.
const CacheProtocol = 1

type SyncError struct {
	Message         string          `json:"message"`
	HTTP            json.RawMessage `json:"http,omitempty"`
	Materialization bool            `json:"materialization,omitempty"`
}

func (e *SyncError) Error() string { return e.Message }

type ResourceResult struct {
	Checked bool   `json:"checked"`
	Updated bool   `json:"updated"`
	Error   string `json:"error,omitempty"`
}

func (r ResourceResult) Err() error {
	if r.Error == "" {
		return nil
	}
	return errors.New(r.Error)
}
func Resource(checked, updated bool, err error) ResourceResult {
	r := ResourceResult{Checked: checked, Updated: updated}
	if err != nil {
		r.Error = err.Error()
	}
	return r
}

// SyncResult travels only over the private local socket. Auth is returned to a
// requesting startup worker, never copied into diagnostics or heartbeat frames.
type SyncResult struct {
	HostStatus string                    `json:"host_status,omitempty"`
	Auth       json.RawMessage           `json:"auth,omitempty"`
	AuthSynced bool                      `json:"auth_synced,omitempty"`
	Sessions   json.RawMessage           `json:"sessions,omitempty"`
	Resources  map[string]ResourceResult `json:"resources,omitempty"`
	Error      *SyncError                `json:"error,omitempty"`
	Generation string                    `json:"generation,omitempty"`
	// Primed answers a "primed" operation: this owner has completed a content
	// pass for the scope, so pushed invalidations keep that content current.
	Primed     bool  `json:"primed,omitempty"`
	Uploaded   bool  `json:"uploaded,omitempty"`
	Adopted    bool  `json:"adopted,omitempty"`
	Deferred   bool  `json:"deferred,omitempty"`
	HostSecure *bool `json:"host_secure,omitempty"`
}

func (r SyncResult) Err() error {
	if r.Error != nil {
		return r.Error
	}
	return nil
}

type SyncRequest struct {
	ReconcileOnly bool     `json:"reconcile_only,omitempty"`
	Job           syncJob  `json:"job"`
	Operation     string   `json:"operation"`
	IncludeAuth   bool     `json:"include_auth,omitempty"`
	Concurrent    bool     `json:"concurrent,omitempty"`
	Args          []string `json:"args,omitempty"`
	// SkipContent asks a bootstrap for its auth/host/version blocks only
	// (`include_content:false`): a warm-cache launch takes content from the
	// owner's primed scope instead. Valid only with an auth-bearing bootstrap.
	SkipContent bool `json:"skip_content,omitempty"`
	// Scheduled marks a content pass started by the owner's own scheduler. It is
	// never sent over the wire: an explicit caller always gets a real exchange.
	Scheduled bool `json:"-"`
}

// SyncManaged is false inside the dedicated worker, avoiding recursive dispatch.
func SyncManaged(base string) bool {
	ep := endpointFor(base)
	if os.Getenv("CXX_COMMUNICATOR_SYNC") == "1" || ep == nil {
		return false
	}
	ep.mu.Lock()
	defer ep.mu.Unlock()
	return ep.syncProtocol == SyncProtocol
}

type configContextKey struct{}

func WithSyncConfig(ctx context.Context, cfg *config.Config) context.Context {
	ctx = context.WithValue(ctx, configContextKey{}, cfg)
	if cfg == nil || cfg.SourcePath() == "" || os.Getenv("CXX_COMMUNICATOR_SYNC") == "1" {
		return ctx
	}
	bindSyncConfig(ctx, cfg)
	return ctx
}

// Binding happens after option parsing and signed-config recovery, so custom
// paths and a newly enabled capability replace the early default discovery.
func bindSyncConfig(ctx context.Context, cfg *config.Config) {
	if cfg.Orchestrator.CommunicatorProtocol != Protocol && cfg.Orchestrator.CommunicatorRuntimeProtocol != residency.Protocol {
		return
	}
	socket, err := resolvedRuntimeSocket(ctx, cfg.Orchestrator.BaseURL)
	base := strings.TrimRight(cfg.Orchestrator.BaseURL, "/")
	value, _ := registry.LoadOrStore(base, &endpoint{base: base, socket: socket, setupErr: err})
	ep := value.(*endpoint)
	if err != nil {
		ep.mu.Lock()
		ep.path, ep.setupErr, ep.syncProtocol = cfg.SourcePath(), err, cfg.Orchestrator.CommunicatorSyncProtocol
		ep.mu.Unlock()
		return
	}
	syncProtocol := cfg.Orchestrator.CommunicatorSyncProtocol
	// Older owners can outlive an atomic binary update. Keep their clients on
	// the proven legacy lifecycle until the owner is replaced; never fail a
	// native launch by sending a new RPC to an old daemon.
	if syncProtocol == SyncProtocol {
		probe, cancel := context.WithTimeout(ctx, time.Second)
		req, _ := http.NewRequestWithContext(probe, "GET", "http://communicator.local/_comm/status", nil)
		res, err := unixClient(socket, time.Second).Do(req)
		if err == nil {
			var status struct {
				Protocol int `json:"protocol"`
				Sync     int `json:"sync_protocol"`
			}
			if json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&status) == nil && status.Protocol == Protocol && status.Sync != SyncProtocol {
				syncProtocol = 0
			}
			res.Body.Close()
		}
		cancel()
	}
	ep.mu.Lock()
	ep.path, ep.setupErr, ep.syncProtocol = cfg.SourcePath(), nil, syncProtocol
	ep.socket, ep.anchor, ep.runtimeOnly = socket, cfg, cfg.Orchestrator.CommunicatorProtocol != Protocol
	ep.mu.Unlock()
	job, err := newSyncJob(ctx, base, cfg.Engine, "")
	if err != nil {
		return
	}
	ep.mu.Lock()
	if ep.jobs == nil {
		ep.jobs = map[string]syncJob{}
	}
	previous := ep.jobs[cfg.Engine]
	ep.jobs[cfg.Engine] = job
	if jobID(previous) != jobID(job) && ep.leaseCancel != nil {
		ep.leaseCancel()
	}
	ep.mu.Unlock()
}

func newSyncJob(ctx context.Context, base, engine, authPath string) (syncJob, error) {
	path, err := config.DefaultPathForEngine(engine)
	if cfg, ok := ctx.Value(configContextKey{}).(*config.Config); ok && cfg.SourcePath() != "" {
		path, err = cfg.SourcePath(), nil
	}
	if err != nil {
		return syncJob{}, err
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return syncJob{}, err
	}
	job := syncJob{Engine: engine, Config: path, Env: map[string]string{}, AuthPath: authPath, Owner: SyncManaged(base)}
	for _, key := range syncEnvKeys {
		if value, ok := os.LookupEnv(key); ok {
			job.Env[key] = value
		}
	}
	return job, nil
}

// Sync submits one finite operation and waits for its result. No generic retry:
// losing the local response leaves a potentially committed auth write unknown.
func Sync(ctx context.Context, base, engine, authPath, operation string, includeAuth, concurrent bool, args []string, account int64, session string) (SyncResult, error) {
	job, err := newSyncJob(ctx, base, engine, authPath)
	if err != nil {
		return SyncResult{}, err
	}
	job.AccountID, job.SessionID = account, session
	return submitSync(ctx, base, SyncRequest{Job: job, Operation: operation, IncludeAuth: includeAuth, Concurrent: concurrent, Args: args})
}

// CacheEnabled reports whether this launch may take content from a primed owner:
// the signed config must carry the cache capability on top of central sync.
func CacheEnabled(ctx context.Context, base string) bool {
	if !SyncManaged(base) {
		return false
	}
	// An insecure host's rendered config embeds a short-lived MCP bearer that
	// expires on a timer, not on an event, so its content is never cached.
	if cfg, ok := ctx.Value(configContextKey{}).(*config.Config); ok && cfg != nil {
		return cfg.Host.Secure && (cfg.Orchestrator.CommunicatorCacheProtocol == CacheProtocol || cfg.Orchestrator.CommunicatorCacheProtocol == LocalContentCacheProtocol)
	}
	ep := endpointFor(base)
	if ep == nil {
		return false
	}
	ep.mu.Lock()
	defer ep.mu.Unlock()
	return ep.anchor != nil && ep.anchor.Host.Secure && (ep.anchor.Orchestrator.CommunicatorCacheProtocol == CacheProtocol || ep.anchor.Orchestrator.CommunicatorCacheProtocol == LocalContentCacheProtocol)
}

// Primed asks the owner whether it already holds current content for this
// engine and native home. A running owner is current by construction (pushed
// invalidations keep it so); only a fresh owner, or a scope it has never
// synchronized, answers false. Any failure, including an older owner that does
// not know the operation, is "not primed": the launch then bootstraps as before.
func Primed(ctx context.Context, base, engine, authPath string) bool {
	// Protocol 2 always asks for a server-confirmed bundle. Primed remains a
	// scheduler hint for old clients, never evidence for a strict launch.
	if cfg, ok := ctx.Value(configContextKey{}).(*config.Config); ok && cfg != nil && cfg.Orchestrator.CommunicatorCacheProtocol == ValidatedCacheProtocol {
		return false
	}
	if ep := endpointFor(base); ep != nil {
		ep.mu.Lock()
		strict := ep.anchor != nil && ep.anchor.Orchestrator.CommunicatorCacheProtocol == ValidatedCacheProtocol
		ep.mu.Unlock()
		if strict {
			return false
		}
	}
	if ExplicitContent(ctx) || !CacheEnabled(ctx, base) {
		return false
	}
	if cfg, ok := ctx.Value(configContextKey{}).(*config.Config); ok && cfg != nil && cfg.Orchestrator.CommunicatorCacheProtocol == LocalContentCacheProtocol {
		owner, ok := OwnerStatus(ctx, base)
		if !ok || owner.Cache.LocalProtocol != LocalContentCacheProtocol {
			return false
		}
	}
	job, err := newSyncJob(ctx, base, engine, authPath)
	if err != nil {
		return false
	}
	probe, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	out, err := submitSync(probe, base, SyncRequest{Job: job, Operation: "primed"})
	return err == nil && out.Error == nil && out.Primed
}

// SyncAuthOnly runs the launch's auth bootstrap without content. It never waits
// behind a background content pass: content and credential work hold separate
// scope locks.
func SyncAuthOnly(ctx context.Context, base, engine, authPath string, args []string, account int64, session string) (SyncResult, error) {
	job, err := newSyncJob(ctx, base, engine, authPath)
	if err != nil {
		return SyncResult{}, err
	}
	job.AccountID, job.SessionID = account, session
	return submitSync(ctx, base, SyncRequest{Job: job, Operation: "bootstrap", IncludeAuth: true, SkipContent: true, Args: args})
}

type explicitContentKey struct{}

// WithExplicitContent marks an explicit sync (`cdx sync`, `clx sync`, the
// post-update pass): it always performs a full content exchange, so Primed
// answers false without asking the owner. cgx sync already sends a content
// operation and never consults Primed.
func WithExplicitContent(ctx context.Context) context.Context {
	return context.WithValue(ctx, explicitContentKey{}, true)
}

// ExplicitContent reports whether WithExplicitContent marked ctx.
func ExplicitContent(ctx context.Context) bool {
	v, _ := ctx.Value(explicitContentKey{}).(bool)
	return v
}

type cachedContentKey struct{}

// WithCachedContent marks a worker's bootstrap as auth-only (see SkipContent).
func WithCachedContent(ctx context.Context) context.Context {
	return context.WithValue(ctx, cachedContentKey{}, true)
}

// CachedContent reports whether the bootstrap must request and apply no content.
func CachedContent(ctx context.Context) bool {
	v, _ := ctx.Value(cachedContentKey{}).(bool)
	return v
}

func submitSync(ctx context.Context, base string, request SyncRequest) (SyncResult, error) {
	ep := endpointFor(base)
	if ep == nil {
		return SyncResult{}, errors.New("communicator is not configured")
	}
	if err := ep.ensure(ctx); err != nil {
		return SyncResult{}, err
	}
	ep.once.Do(func() { go ep.lease(processContext) })
	raw, err := json.Marshal(request)
	if err != nil {
		return SyncResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "http://communicator.local/_comm/sync", bytes.NewReader(raw))
	if err != nil {
		return SyncResult{}, err
	}
	res, err := unixClient(ep.localSocket(), 0).Do(req)
	if err != nil {
		return SyncResult{}, errors.New("communicator sync response lost; outcome unknown")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return SyncResult{}, fmt.Errorf("communicator sync rejected (HTTP %d); run cxx communicator doctor", res.StatusCode)
	}
	var out SyncResult
	if err := json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&out); err != nil {
		return out, fmt.Errorf("communicator sync response incomplete: %w", err)
	}
	return out, nil
}

// WatchAuth hands the repeating work to the communicator. The stream carries
// metadata only; each attached wrapper can retain its own purge/session policy.
// Reconnect never activates a competing per-session polling loop.
func WatchAuth(ctx context.Context, base, engine, authPath string, account int64, session, broker string, observe func(AuthStatus), fallback func(context.Context) func()) (func(), error) {
	job, err := newSyncJob(ctx, base, engine, authPath)
	if err != nil {
		return nil, err
	}
	job.Auth, job.AccountID, job.SessionID, job.Broker = true, account, session, broker
	ep := endpointFor(base)
	if ep == nil {
		return nil, errors.New("communicator not configured")
	}
	child, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for child.Err() == nil {
			if ep.ensure(child) == nil {
				raw, _ := json.Marshal([]syncJob{job})
				req, _ := http.NewRequestWithContext(child, "POST", "http://communicator.local/_comm/lease", bytes.NewReader(raw))
				res, err := unixClient(ep.localSocket(), 0).Do(req)
				if err == nil {
					if res.StatusCode == http.StatusOK {
						scanner := bufio.NewScanner(res.Body)
						scanner.Buffer(make([]byte, 4096), 1<<20)
						for scanner.Scan() {
							var status AuthStatus
							if json.Unmarshal(scanner.Bytes(), &status) == nil {
								if status.Type == "auth_handoff" && signedSyncDisabled(job) {
									res.Body.Close()
									ep.mu.Lock()
									ep.syncProtocol = 0
									ep.mu.Unlock()
									if fallback != nil {
										stop := fallback(child)
										defer stop()
										<-child.Done()
									}
									return
								}
								if status.Type == "auth_state" && observe != nil {
									observe(status)
								}
							}
						}
					}
					res.Body.Close()
				}
			}
			select {
			case <-child.Done():
				return
			case <-time.After(time.Second):
			}
		}
	}()
	return func() { cancel(); <-done }, nil
}

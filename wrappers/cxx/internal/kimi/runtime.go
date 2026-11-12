package kimi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeargs"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
	"github.com/pelletier/go-toml"
)

const AuthSocketEnv = "CXX_KIMI_AUTH_SOCKET"
const OfficialClientID = "17e5f671-d194-4dfb-9706-5516cb48c098"

type Credential struct {
	Key          string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresAt    int64  `json:"expires_at"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
	TokenType    string `json:"token_type"`
}
type AuthEnvelope struct {
	KimiCode    Credential `json:"kimi_code"`
	DeviceID    string     `json:"device_id"`
	OAuthHost   string     `json:"oauth_host,omitempty"`
	BaseURL     string     `json:"base_url,omitempty"`
	LastRefresh string     `json:"last_refresh,omitempty"`
}
type Projection struct {
	Status              string          `json:"status"`
	Auth                json.RawMessage `json:"auth"`
	AccountID           int64           `json:"account_id"`
	VerificationState   string          `json:"verification_state"`
	CanonicalGeneration int64           `json:"canonical_generation"`
	AccessTokenDigest   string          `json:"access_token_digest"`
	ExpiresAt           string          `json:"expires_at"`
	AccountPool         bool            `json:"account_pool"`
}
type issuance struct {
	Generation int64     `json:"canonical_generation"`
	Digest     string    `json:"access_token_digest"`
	ExpiresAt  time.Time `json:"expires_at"`
}

// Runtime's provider secrets are access-only and never leave its owned directory.
// The original native home contributes explicitly selected authored/history paths.
type Runtime struct {
	Dir, Home, BaseHome, AuthPath, Socket string
	Client                                *orchestrator.Client
	Pool                                  *accountpool.Context
	mu                                    sync.Mutex
	issued                                []issuance
	server                                *http.Server
	listener                              net.Listener
	// Selection snapshot for startup/status, independent of mutable process env.
	overlay          string
	sessionLease     *ipc.Lock
	privateDirectory *PrivateDirectory
	// Warnings are launch notices for degraded but working private homes.
	Warnings []string
}

// Native home assets carried into the private KIMI_CODE_HOME, decided against the
// Kimi Code 2.5.3 home contract (docs/interface-ckx.md).
var runtimeLinkedAssets = []string{"sessions", "skills", "agents", "store", "blobs", "cache"}
var runtimeCopiedAssets = []string{"AGENTS.md", "SYSTEM.md", "config.toml", "tui.toml", "mcp.json", "projects.json"}

func nativeProjection(raw json.RawMessage) (AuthEnvelope, Credential, error) {
	var envelope AuthEnvelope
	if json.Unmarshal(raw, &envelope) != nil {
		return envelope, Credential{}, errors.New("invalid Kimi auth envelope")
	}
	c := envelope.KimiCode
	device, err := hex.DecodeString(envelope.DeviceID)
	if c.Key == "" || strings.ContainsAny(c.Key, "\r\n\x00") || c.RefreshToken != "" || c.ExpiresAt != 0 || c.ExpiresIn != 0 || c.Scope != "kimi-code" || c.TokenType != "Bearer" || err != nil || len(device) != 16 {
		return envelope, c, errors.New("Kimi runtime requires an access-only projection and canonical device id")
	}
	return envelope, c, nil
}

func NewRuntime(baseHome string, cfg *config.Config, client *orchestrator.Client, pool *accountpool.Context, lifetimeLeases ...*ipc.Lock) (*Runtime, error) {
	guard, err := sessionguard.LaunchAt(baseHome)
	if err != nil {
		return nil, err
	}
	defer guard.Release()
	// Existing native lifetime lease below remains shared with housekeeping.
	lease, err := ipc.TryAcquireSharedPath(filepath.Join(baseHome, ".ckx-sessions.lock"))
	if err != nil {
		return nil, err
	}
	owned := false
	defer func() {
		if !owned {
			_ = lease.Release()
		}
	}()
	if err := SweepPrivateDirectories(); err != nil {
		return nil, err
	}
	state, err := StateDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(state, "runtimes"), 0o700); err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(filepath.Join(state, "runtimes"), "session-")
	if err != nil {
		return nil, err
	}
	// Darwin's Unix socket address is smaller than Linux's. Long user homes
	// keep the same isolation using a protected compact temporary root.
	if len(filepath.Join(dir, "kimi.sock")) >= 100 {
		_ = os.RemoveAll(dir)
		dir, err = os.MkdirTemp("/tmp", "ckx-runtime-")
		if err != nil {
			return nil, err
		}
	}
	r := &Runtime{Dir: dir, Home: filepath.Join(dir, "home"), BaseHome: baseHome, Client: client, Pool: pool, Socket: filepath.Join(dir, "auth.sock"), sessionLease: lease}
	protected, err := GuardPrivateDirectory(dir, append([]*ipc.Lock{lease}, lifetimeLeases...)...)
	if err != nil {
		return nil, err
	}
	r.privateDirectory = protected
	owned = true
	r.AuthPath = filepath.Join(r.Home, "credentials", "kimi-code.json")
	if err := os.MkdirAll(r.Home, 0o700); err != nil {
		r.Close()
		return nil, err
	}
	for _, name := range runtimeLinkedAssets {
		path := filepath.Join(baseHome, name)
		if _, err := os.Stat(path); os.IsNotExist(err) {
			if err := os.MkdirAll(path, 0o700); err != nil {
				r.Close()
				return nil, err
			}
		} else if err != nil {
			r.Close()
			return nil, err
		}
		if err := os.Symlink(path, filepath.Join(r.Home, name)); err != nil {
			r.Close()
			return nil, err
		}
	}
	for _, name := range runtimeCopiedAssets {
		if err := copyOptional(filepath.Join(baseHome, name), filepath.Join(r.Home, name)); err != nil {
			r.Close()
			return nil, err
		}
	}
	if err := prepareDurableCatalog(r.Dir, baseHome); err != nil {
		r.Close()
		return nil, err
	}
	return r, nil
}

// Maintenance is scoped to the original native home, even though credentials
// themselves live in isolated homes. No remote or local removal precedes it.
func TryAcquireMaintenance(baseHome string) (*ipc.Lock, error) {
	return ipc.TryAcquireExclusivePath(filepath.Join(baseHome, ".ckx-sessions.lock"))
}

// AttachChild preserves the activity lease if the wrapper is killed while an
// owned native leader or TUI survives. Close only the parent's duplicate after
// Start; the child retains its copy until it exits.
func (r *Runtime) AttachChild(cmd *exec.Cmd) (func(), error) {
	lease, err := r.sessionLease.DuplicateForExec()
	if err != nil {
		return nil, err
	}
	cmd.ExtraFiles = append(cmd.ExtraFiles, lease.File())
	closePrivate, err := r.privateDirectory.Attach(cmd)
	if err != nil {
		_ = lease.Release()
		return nil, err
	}
	return func() { closePrivate(); _ = lease.Release() }, nil
}

func copyOptional(source, dest string) error {
	f, err := os.Open(source)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil {
		return err
	} else if !info.Mode().IsRegular() {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(f, (16<<20)+1))
	if err != nil {
		return err
	}
	if len(raw) > 16<<20 {
		return errors.New("native config asset exceeds snapshot limit")
	}
	return AtomicWrite(dest, raw, 0o600)
}
func mergeMap(dst, src map[string]any) {
	for key, value := range src {
		if nested, ok := value.(map[string]any); ok {
			target, _ := dst[key].(map[string]any)
			if target == nil {
				target = map[string]any{}
			}
			mergeMap(target, nested)
			dst[key] = target
		} else {
			dst[key] = value
		}
	}
}

func (r *Runtime) Apply(raw json.RawMessage, generation int64) error {
	envelope, credential, err := nativeProjection(raw)
	if err != nil {
		return err
	}
	data, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	if err := AtomicWrite(filepath.Join(r.Home, "device_id"), []byte(envelope.DeviceID), 0600); err != nil {
		return err
	}
	if err := AtomicWrite(r.AuthPath, data, 0600); err != nil {
		return err
	}
	if generation > 0 {
		r.record(credential, generation)
	}
	return nil
}
func tokenDigest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (r *Runtime) record(credential Credential, generation int64) {
	i := issuance{Generation: generation, Digest: tokenDigest(credential.Key), ExpiresAt: time.Time{}}
	next := []issuance{i}
	for _, old := range r.issued {
		if old.Digest != i.Digest && len(next) < 2 {
			next = append(next, old)
		}
	}
	r.issued = next
	raw, _ := json.Marshal(map[string]any{"account_id": r.Pool.AccountID, "session_id": r.Pool.SessionID, "issued": r.issued})
	_ = AtomicWrite(filepath.Join(r.Dir, "issued.json"), raw, 0o600)
}
func (r *Runtime) retrieve(ctx context.Context, refresh bool) (*Projection, Credential, error) {
	body := map[string]any{"engine": "kimi", "command": "retrieve"}
	var projection Projection
	if err := r.Client.JSON(ctx, http.MethodPost, "/auth", body, &projection, 0); err != nil {
		return nil, Credential{}, err
	}
	credential, err := r.validateProjection(&projection)
	if err != nil {
		return nil, Credential{}, err
	}
	return &projection, credential, nil
}

// validateProjection applies the same account, generation and access-only
// credential checks to a lease projection and a later auth response.
func (r *Runtime) validateProjection(projection *Projection) (Credential, error) {
	if projection.AccountID != r.Pool.AccountID || projection.VerificationState != "verified" || projection.CanonicalGeneration <= 0 {
		return Credential{}, errors.New("Kimi auth response changed leased account or lacks verification")
	}
	_, credential, err := nativeProjection(projection.Auth)
	if err != nil {
		return Credential{}, err
	}
	if projection.AccessTokenDigest != "" && projection.AccessTokenDigest != tokenDigest(credential.Key) {
		return Credential{}, errors.New("Kimi access-token digest mismatch")
	}
	if projection.AccessTokenDigest == "" {
		return Credential{}, errors.New("Kimi access-token digest missing")
	}
	expires, err := time.Parse(time.RFC3339Nano, projection.ExpiresAt)
	if err != nil || !expires.After(time.Now().Add(5*time.Second)) {
		return Credential{}, errors.New("Kimi access token has no remaining lifetime")
	}
	if len(r.issued) > 0 && projection.CanonicalGeneration < r.issued[0].Generation {
		return Credential{}, errors.New("Kimi canonical generation regressed")
	}
	return credential, nil
}

// Initialize is the sole wrapper-side native write after lease assignment.
// It runs before any native process can retain a bearer in memory.
func (r *Runtime) Initialize(ctx context.Context, leases ...*accountpool.LeaseResponse) error {
	if err := r.lock(ctx); err != nil {
		return err
	}
	defer r.mu.Unlock()
	// Current servers already ensured freshness while reserving the account.
	// Reuse that exact projection before native exec; older responses still
	// retrieve it. A complete but inconsistent response is refused.
	if len(leases) > 0 && leases[0] != nil {
		lease := leases[0]
		if lease.CanonicalGeneration > 0 && lease.AccessTokenDigest != "" && lease.AccessExpiresAt != "" {
			projection := &Projection{AccountID: lease.AccountID, Auth: lease.Auth, VerificationState: lease.VerificationState, CanonicalGeneration: lease.CanonicalGeneration, AccessTokenDigest: lease.AccessTokenDigest, ExpiresAt: lease.AccessExpiresAt}
			if _, err := r.validateProjection(projection); err != nil {
				return err
			}
			return r.Apply(projection.Auth, projection.CanonicalGeneration)
		}
	}
	projection, _, err := r.retrieve(ctx, false)
	if err != nil {
		return err
	}
	return r.Apply(projection.Auth, projection.CanonicalGeneration)
}

// Refresh renews server readiness without marking a fetched head as issued.
// The native auth provider owns subsequent native cache writes. A heartbeat
// must not disguise the generation of the bearer that a 401 actually rejected.
func (r *Runtime) Refresh(ctx context.Context) error {
	if err := r.lock(ctx); err != nil {
		return err
	}
	defer r.mu.Unlock()
	projection, _, err := r.retrieve(ctx, false)
	if err != nil {
		return err
	}
	return r.Apply(projection.Auth, projection.CanonicalGeneration)
}

// sessionNotFoundRecheck is the production policy; tests substitute a fake clock.
var sessionNotFoundRecheck communicator.RecheckPolicy

// SessionNotFound reports the server's 404 "Account session not found", which a
// connection-mode lease answers while its provider attachment is redialing.
func SessionNotFound(err error) bool {
	var httpErr *orchestrator.HTTPError
	return errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusNotFound
}

// RefreshConfirmed is Refresh for the session's readiness loop. A 404 is
// re-checked (communicator.NotFoundRechecks times, NotFoundRecheckSpacing apart)
// before it is returned, so FatalAuthError sees it only when it persisted. Any
// other answer, including 401 and 409, is returned at once; cancelling ctx ends
// the wait promptly. Each call is bounded by callTimeout.
func (r *Runtime) RefreshConfirmed(ctx context.Context, callTimeout time.Duration) error {
	return confirmRefresh(ctx, sessionNotFoundRecheck, func(c context.Context) error {
		callCtx, cancel := context.WithTimeout(c, callTimeout)
		defer cancel()
		return r.Refresh(callCtx)
	})
}

func confirmRefresh(ctx context.Context, policy communicator.RecheckPolicy, call func(context.Context) error) error {
	err := call(ctx)
	if !SessionNotFound(err) {
		return err
	}
	return communicator.ConfirmNotFound(ctx, policy, call, SessionNotFound)
}

func FatalAuthError(err error) bool {
	var httpErr *orchestrator.HTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	return httpErr.StatusCode == http.StatusUnauthorized || httpErr.StatusCode == http.StatusNotFound ||
		(httpErr.StatusCode == http.StatusConflict && httpErr.Code != "communicator_outcome_unknown")
}

func (r *Runtime) lock(ctx context.Context) error {
	for !r.mu.TryLock() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err := ctx.Err(); err != nil {
		r.mu.Unlock()
		return err
	}
	return nil
}

func (r *Runtime) StartAuthBroker(ctx context.Context) error {
	listener, err := net.Listen("unix", r.Socket)
	if err != nil {
		return err
	}
	if err := os.Chmod(r.Socket, 0o600); err != nil {
		listener.Close()
		return err
	}
	r.listener = listener
	mux := http.NewServeMux()
	mux.HandleFunc("/readiness", func(w http.ResponseWriter, req *http.Request) {
		if req.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), 5500*time.Millisecond)
		defer cancel()
		err := r.Refresh(ctx)
		result := communicator.SyncResult{}
		if err != nil {
			result.Error = &communicator.SyncError{Message: err.Error()}
			var h *orchestrator.HTTPError
			if errors.As(err, &h) {
				result.Error.HTTP, _ = json.Marshal(h)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: time.Second, ReadTimeout: 6 * time.Second, WriteTimeout: 6 * time.Second}
	r.server = server
	go func() { _ = server.Serve(listener) }()
	go func() { <-ctx.Done(); _ = server.Close() }()
	return nil
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

type ModelPreferences struct{ Model, Effort string }

func ProcessModelPreferences() ModelPreferences {
	var prefs ModelPreferences
	if home, err := Home(); err == nil {
		if tree, err := toml.LoadFile(filepath.Join(home, "config.toml")); err == nil {
			prefs.Model, _ = tree.Get("default_model").(string)
			prefs.Effort, _ = tree.Get("thinking.effort").(string)
		}
	}
	if effort := strings.TrimSpace(os.Getenv("CKX_LAUNCH_EFFORT")); effort != "" {
		prefs.Effort = effort
	}
	return prefs
}
func (r *Runtime) ModelPreferences() ModelPreferences {
	var prefs ModelPreferences
	_ = json.Unmarshal([]byte(r.overlay), &prefs)
	return prefs
}
func (r *Runtime) Configure(executable string, cfg *config.Config, portal bool, launchArgs ...[]string) error {
	m := map[string]any{}
	if raw, err := os.ReadFile(filepath.Join(r.Home, "config.toml")); err == nil {
		tree, err := toml.LoadBytes(raw)
		if err != nil {
			return err
		}
		m = tree.ToMap()
	} else if !os.IsNotExist(err) {
		return err
	}
	m["telemetry"], m["auto_session_title"], m["disable_feedback_survey"] = false, false, true
	providers, _ := m["providers"].(map[string]any)
	if providers == nil {
		providers = map[string]any{}
	}
	providers["managed:kimi-code"] = map[string]any{"type": "kimi", "base_url": "https://api.kimi.com/coding/v1", "oauth": map[string]any{"storage": "file", "key": "oauth/kimi-code"}}
	m["providers"] = providers
	model := cfg.EngineOptions.ModelOverride
	if cfg.EngineOptions.KimiModelOverride != nil {
		model = cfg.EngineOptions.KimiModelOverride
	}
	effort := cfg.EngineOptions.ReasoningEffortOverride
	if value := os.Getenv("CKX_LAUNCH_EFFORT"); value != "" {
		effort = &value
	}
	if cfg.EngineOptions.KimiReasoningEffortOverride != nil {
		effort = cfg.EngineOptions.KimiReasoningEffortOverride
	}
	if model != nil {
		m["default_model"] = *model
	}
	if m["default_model"] == nil {
		m["default_model"] = "kimi-code/kimi-for-coding"
	}
	models, _ := m["models"].(map[string]any)
	if models == nil {
		models = map[string]any{}
	}
	selected, _ := m["default_model"].(string)
	if len(launchArgs) > 0 {
		if value := nativeargs.Value("kimi", launchArgs[0], "--model"); value != "" {
			selected = value
		}
	}
	if _, exists := models[selected]; !exists {
		models[selected] = map[string]any{"provider": "managed:kimi-code", "model": strings.TrimPrefix(selected, "kimi-code/"), "max_context_size": 262144}
	}
	m["models"] = models
	thinking, _ := m["thinking"].(map[string]any)
	if thinking == nil {
		thinking = map[string]any{}
	}
	if effort != nil {
		if *effort != "low" && *effort != "high" && *effort != "max" {
			return errors.New("invalid Kimi thinking effort")
		}
		thinking["effort"] = *effort
	}
	m["thinking"] = thinking
	if m["default_permission_mode"] == nil {
		m["default_permission_mode"] = "manual"
	}
	if cfg.EngineOptions.DangerouslyBypassApprovalsAndSandbox {
		m["default_permission_mode"] = "auto"
	}
	if portal {
		hooks, _ := m["hooks"].([]any)
		kept := make([]any, 0, len(hooks)+2)
		for _, h := range hooks {
			entry, _ := h.(map[string]any)
			command, _ := entry["command"].(string)
			if !strings.Contains(command, " agent poll --hook ") {
				kept = append(kept, h)
			}
		}
		for _, event := range []string{"UserPromptSubmit", "Stop"} {
			kept = append(kept, map[string]any{"event": event, "command": shellQuote(executable) + " agent poll --hook " + event + " --dialect kimi", "timeout": int64(30)})
		}
		m["hooks"] = kept
	}
	prefs := ModelPreferences{Model: selected}
	prefs.Effort, _ = thinking["effort"].(string)
	overlay, _ := json.Marshal(prefs)
	r.overlay = string(overlay)
	tree, err := toml.TreeFromMap(m)
	if err != nil {
		return err
	}
	data, err := tree.ToTomlString()
	if err != nil {
		return err
	}
	if err := AtomicWrite(filepath.Join(r.Home, "config.toml"), []byte(data), 0600); err != nil {
		return err
	}
	servers := map[string]any{}

	if raw, err := os.ReadFile(filepath.Join(r.Home, "mcp.json")); err == nil {
		var existing struct {
			Servers map[string]any `json:"mcpServers"`
		}
		if json.Unmarshal(raw, &existing) != nil {
			return errors.New("invalid Kimi mcp.json")
		}
		mergeMap(servers, existing.Servers)
	} else if !os.IsNotExist(err) {
		return err
	}
	if nativeServers, ok := m["mcp_servers"].(map[string]any); ok {
		for name, value := range nativeServers {
			servers[name] = value
		}
	}
	if portal {
		servers["cxx-agent"] = map[string]any{"command": executable, "args": []string{"agent", "mcp", "--auto"}}
	}
	raw, err := json.Marshal(map[string]any{"mcpServers": servers})
	if err != nil {
		return err
	}
	return AtomicWrite(filepath.Join(r.Home, "mcp.json"), raw, 0600)
}
func (r *Runtime) Environment(env []string) []string {
	out := make([]string, 0, len(env))
	for _, item := range env {
		key, _, _ := strings.Cut(item, "=")
		if strings.HasPrefix(key, "KIMI_MODEL_") || key == "KIMI_CODE_HOME" || key == "KIMI_API_KEY" || key == "KIMI_CODE_BASE_URL" || key == "KIMI_CODE_OAUTH_HOST" || key == "KIMI_OAUTH_HOST" {
			continue
		}
		out = append(out, item)
	}
	out = SetEnv(out, "KIMI_CODE_HOME", r.Home)
	out = SetEnv(out, "CXX_KIMI_BASE_HOME", r.BaseHome)
	out = SetEnv(out, AuthSocketEnv, r.Socket)
	return NativeEnv(out)
}
func (r *Runtime) Close() error {
	if r.server != nil {
		_ = r.server.Close()
	}
	if r.listener != nil {
		_ = r.listener.Close()
	}
	if r.Dir != "" {
		err := r.privateDirectory.Close()
		if r.sessionLease != nil {
			err = errors.Join(err, r.sessionLease.Release())
			r.sessionLease = nil
		}
		return err
	}
	return nil
}

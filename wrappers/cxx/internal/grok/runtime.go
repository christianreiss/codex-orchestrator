package grok

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/pelletier/go-toml"
)

const AuthSocketEnv = "CXX_GROK_AUTH_SOCKET"
const OfficialClientID = "b1a00492-073a-47ea-816f-4c329264a828"
const OfficialScope = "https://auth.x.ai::" + OfficialClientID

type Credential struct {
	Key        string    `json:"key"`
	AuthMode   string    `json:"auth_mode"`
	CreateTime time.Time `json:"create_time"`
	ExpiresAt  time.Time `json:"expires_at"`
	Issuer     string    `json:"oidc_issuer"`
	ClientID   string    `json:"oidc_client_id,omitempty"`
	UserID     string    `json:"user_id"`
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
	effective                             string
	sessionLease                          *ipc.Lock
}

func nativeProjection(raw json.RawMessage) (map[string]json.RawMessage, string, Credential, error) {
	var envelope struct {
		GrokAuth map[string]json.RawMessage `json:"grok_auth"`
		Scope    string                     `json:"grok_scope"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, "", Credential{}, errors.New("invalid Grok auth envelope")
	}
	if len(envelope.GrokAuth) == 0 || envelope.Scope != OfficialScope {
		return nil, "", Credential{}, errors.New("Grok access projection missing native credential map")
	}
	var selected string
	var credential Credential
	for scope, raw := range envelope.GrokAuth {
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil {
			return nil, "", credential, errors.New("invalid Grok credential")
		}
		if rt, ok := fields["refresh_token"]; ok && string(rt) != "null" && string(rt) != `""` {
			return nil, "", credential, errors.New("Grok runtime projection contains a refresh token")
		}
		if scope != envelope.Scope {
			var key string
			_ = json.Unmarshal(fields["key"], &key)
			if key != "" {
				return nil, "", credential, errors.New("Grok runtime contains an unselected credential")
			}
			continue
		}
		var c Credential
		if json.Unmarshal(raw, &c) != nil || c.AuthMode != "external" || c.Issuer != "https://auth.x.ai" || c.Key == "" || c.ExpiresAt.IsZero() {
			return nil, "", credential, errors.New("Grok runtime requires first-party external session credentials")
		}
		if strings.ContainsAny(c.Key, "\r\n\x00") || scope != OfficialScope || c.ClientID != OfficialClientID {
			return nil, "", credential, errors.New("invalid Grok session scope")
		}
		if selected != "" {
			return nil, "", credential, errors.New("ambiguous Grok subscription credential map")
		}
		selected, credential = scope, c
	}
	if selected == "" {
		return nil, "", credential, errors.New("selected Grok subscription credential missing")
	}
	return envelope.GrokAuth, selected, credential, nil
}

func NewRuntime(baseHome string, cfg *config.Config, client *orchestrator.Client, pool *accountpool.Context) (*Runtime, error) {
	lease, err := ipc.TryAcquireSharedPath(filepath.Join(baseHome, ".cgx-sessions.lock"))
	if err != nil {
		return nil, err
	}
	owned := false
	defer func() {
		if !owned {
			_ = lease.Release()
		}
	}()
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
	if len(filepath.Join(dir, "grok.sock")) >= 100 {
		_ = os.RemoveAll(dir)
		dir, err = os.MkdirTemp("/tmp", "cgx-runtime-")
		if err != nil {
			return nil, err
		}
	}
	r := &Runtime{Dir: dir, Home: filepath.Join(dir, "home"), BaseHome: baseHome, Client: client, Pool: pool, Socket: filepath.Join(dir, "auth.sock"), sessionLease: lease}
	owned = true
	r.AuthPath = filepath.Join(r.Home, "auth.json")
	if err := os.MkdirAll(r.Home, 0o700); err != nil {
		r.Close()
		return nil, err
	}
	for _, name := range []string{"sessions", "worktrees", "memory", "memory-v2", "rules", "skills", "commands", "personas", "agents", "bundled", "plugins"} {
		path := filepath.Join(baseHome, name)
		if _, err := os.Stat(path); os.IsNotExist(err) {
			if name != "sessions" {
				continue
			}
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
	for _, name := range []string{"AGENTS.md", "CLAUDE.md", "Claude.md", "claude.md", "GROK.md", "config.toml", "requirements.toml", "managed-config.toml", "trusted-plugins", "trusted-hook-projects"} {
		if err := copyOptional(filepath.Join(baseHome, name), filepath.Join(r.Home, name)); err != nil {
			r.Close()
			return nil, err
		}
	}
	// Global hook roots must be real directories in Grok. Copy only hook definitions.
	if entries, err := os.ReadDir(filepath.Join(baseHome, "hooks")); err == nil {
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			if err := copyOptional(filepath.Join(baseHome, "hooks", entry.Name()), filepath.Join(r.Home, "hooks", entry.Name())); err != nil {
				r.Close()
				return nil, err
			}
		}
	} else if !os.IsNotExist(err) {
		r.Close()
		return nil, err
	}
	return r, nil
}

// Maintenance is scoped to the original native home, even though credentials
// themselves live in isolated homes. No remote or local removal precedes it.
func TryAcquireMaintenance(baseHome string) (*ipc.Lock, error) {
	return ipc.TryAcquireExclusivePath(filepath.Join(baseHome, ".cgx-sessions.lock"))
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
	return func() { _ = lease.Release() }, nil
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
	store, _, credential, err := nativeProjection(raw)
	if err != nil {
		return err
	}
	if !credential.ExpiresAt.After(time.Now().Add(5 * time.Second)) {
		return errors.New("Grok subscription access token expired")
	}
	data, err := json.Marshal(store)
	if err != nil {
		return err
	}
	if err := AtomicWrite(r.AuthPath, data, 0o600); err != nil {
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
	i := issuance{Generation: generation, Digest: tokenDigest(credential.Key), ExpiresAt: credential.ExpiresAt}
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
	body := map[string]any{"engine": "grok", "command": "retrieve"}
	observed := int64(0)
	if refresh {
		raw, err := os.ReadFile(r.AuthPath)
		if err != nil {
			return nil, Credential{}, errors.New("Grok native access cache unavailable")
		}
		var store map[string]Credential
		if json.Unmarshal(raw, &store) != nil {
			return nil, Credential{}, errors.New("Grok native cache invalid")
		}
		for _, c := range store {
			for _, issued := range r.issued {
				if issued.Digest == tokenDigest(c.Key) {
					observed = issued.Generation
				}
			}
		}
		if observed <= 0 {
			return nil, Credential{}, errors.New("Grok native credential generation unknown")
		}
		body["refresh_if_generation"] = observed
	}
	var projection Projection
	if err := r.Client.JSON(ctx, http.MethodPost, "/auth", body, &projection, 0); err != nil {
		return nil, Credential{}, err
	}
	if projection.AccountID != r.Pool.AccountID || projection.VerificationState != "verified" || projection.CanonicalGeneration <= 0 {
		return nil, Credential{}, errors.New("Grok auth response changed leased account or lacks verification")
	}
	_, _, credential, err := nativeProjection(projection.Auth)
	if err != nil {
		return nil, Credential{}, err
	}
	if projection.AccessTokenDigest != "" && projection.AccessTokenDigest != tokenDigest(credential.Key) {
		return nil, Credential{}, errors.New("Grok access-token digest mismatch")
	}
	if projection.AccessTokenDigest == "" {
		return nil, Credential{}, errors.New("Grok access-token digest missing")
	}
	expires, err := time.Parse(time.RFC3339Nano, projection.ExpiresAt)
	if err != nil || !expires.Equal(credential.ExpiresAt) {
		return nil, Credential{}, errors.New("Grok access-token expiry mismatch")
	}
	if len(r.issued) > 0 && projection.CanonicalGeneration < r.issued[0].Generation {
		return nil, Credential{}, errors.New("Grok canonical generation regressed")
	}
	if refresh && projection.CanonicalGeneration <= observed {
		return nil, Credential{}, errors.New("Grok refresh returned no successor")
	}
	if !credential.ExpiresAt.After(time.Now().Add(5 * time.Second)) {
		return nil, Credential{}, errors.New("Grok access token has no remaining lifetime")
	}
	return &projection, credential, nil
}

// Initialize is the sole wrapper-side native write after lease assignment.
// It runs before any native process can retain a bearer in memory.
func (r *Runtime) Initialize(ctx context.Context) error {
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

// Refresh renews server readiness without marking a fetched head as issued.
// The native auth provider owns subsequent native cache writes. A heartbeat
// must not disguise the generation of the bearer that a 401 actually rejected.
func (r *Runtime) Refresh(ctx context.Context) error {
	if err := r.lock(ctx); err != nil {
		return err
	}
	defer r.mu.Unlock()
	_, _, err := r.retrieve(ctx, false)
	return err
}

func FatalAuthError(err error) bool {
	var httpErr *orchestrator.HTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	return httpErr.StatusCode == http.StatusUnauthorized || httpErr.StatusCode == http.StatusNotFound || httpErr.StatusCode == http.StatusConflict
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
	mux.HandleFunc("/token", func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var in struct {
			Refresh bool `json:"refresh"`
		}
		if json.NewDecoder(io.LimitReader(req.Body, 4096)).Decode(&in) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		callCtx, cancel := context.WithTimeout(req.Context(), 5500*time.Millisecond)
		defer cancel()
		if err := r.lock(callCtx); err != nil {
			http.Error(w, "Grok authentication pending", http.StatusServiceUnavailable)
			return
		}
		defer r.mu.Unlock()
		projection, credential, err := r.retrieve(callCtx, in.Refresh)
		if err != nil {
			http.Error(w, "Grok subscription authentication unavailable", http.StatusServiceUnavailable)
			return
		}
		r.record(credential, projection.CanonicalGeneration)
		seconds := int64(time.Until(credential.ExpiresAt).Seconds())
		if seconds <= 5 {
			http.Error(w, "Grok token lifetime too short", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": credential.Key, "expires_in": seconds, "issuer": "https://auth.x.ai"})
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: time.Second, ReadTimeout: 6 * time.Second, WriteTimeout: 6 * time.Second}
	r.server = server
	go func() { _ = server.Serve(listener) }()
	go func() { <-ctx.Done(); _ = server.Close() }()
	return nil
}

// RunAuthAccessor is intentionally separate from persona dispatch: native holds
// its auth-file lock during this call. No lifecycle, lease, or native file write.
func RunAuthAccessor(ctx context.Context, stdout, stderr io.Writer) int {
	socket := os.Getenv(AuthSocketEnv)
	if socket == "" {
		fmt.Fprintln(stderr, "Grok auth broker missing")
		return 1
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	body, _ := json.Marshal(map[string]bool{"refresh": os.Getenv("GROK_AUTH_EXPIRED") == "1"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://grok-auth/token", bytes.NewReader(body))
	if err != nil {
		return 1
	}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintln(stderr, "Grok subscription auth broker unavailable")
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(stderr, "Grok subscription authentication pending or requires login")
		return 1
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return 1
	}
	var out struct {
		AccessToken  string          `json:"access_token"`
		ExpiresIn    int64           `json:"expires_in"`
		Issuer       string          `json:"issuer"`
		RefreshToken json.RawMessage `json:"refresh_token"`
	}
	if json.Unmarshal(raw, &out) != nil || out.AccessToken == "" || out.ExpiresIn <= 5 || out.Issuer != "https://auth.x.ai" || len(out.RefreshToken) > 0 {
		fmt.Fprintln(stderr, "Grok subscription auth broker returned invalid credentials")
		return 1
	}
	if _, err := stdout.Write(raw); err != nil {
		return 1
	}
	return 0
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }
func (r *Runtime) Configure(executable string, cfg *config.Config, portal bool) error {
	raw, err := os.ReadFile(filepath.Join(r.Home, "config.toml"))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	m := map[string]any{}
	if len(raw) > 0 {
		tree, err := toml.LoadBytes(raw)
		if err != nil {
			return err
		}
		m = tree.ToMap()
	}
	// Preserve user process overlays before applying the owned auth boundary.
	if inline := os.Getenv("GROK_CONFIG"); strings.TrimSpace(inline) != "" {
		var overlay map[string]any
		if json.Unmarshal([]byte(inline), &overlay) != nil {
			return errors.New("invalid GROK_CONFIG JSON overlay")
		}
		mergeMap(m, overlay)
	} else if path := os.Getenv("GROK_CONFIG_PATH"); strings.TrimSpace(path) != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return errors.New("GROK_CONFIG_PATH overlay unavailable")
		}
		var overlay map[string]any
		if json.Unmarshal(data, &overlay) != nil {
			tree, err := toml.LoadBytes(data)
			if err != nil {
				return errors.New("invalid GROK_CONFIG_PATH overlay")
			}
			overlay = tree.ToMap()
		}
		mergeMap(m, overlay)
	}
	// The native alias merges auth into grok_com_config. Remove either custom
	// IdP before pinning the one canonical subscription scope.
	delete(m, "auth")
	gcc, _ := m["grok_com_config"].(map[string]any)
	delete(gcc, "oidc")
	delete(gcc, "oauth2")
	managed := map[string]any{"grok_com_config": map[string]any{"auth_provider_command": shellQuote(executable) + " grok-auth", "disable_api_key_auth": true, "preferred_method": "oidc", "oauth2": map[string]any{"issuer": "https://auth.x.ai", "client_id": OfficialClientID}}}
	if portal {
		if servers, ok := m["mcp_servers"].(map[string]any); ok {
			delete(servers, "cxx-agent")
		}
		managed["mcp_servers"] = map[string]any{"cxx-agent": map[string]any{"command": executable, "args": []string{"agent", "mcp", "--auto"}}}
	}
	mergeMap(m, managed)
	if cfg.EngineOptions.ModelOverride != nil {
		mergeMap(m, map[string]any{"models": map[string]any{"default": *cfg.EngineOptions.ModelOverride}})
	}
	if cfg.EngineOptions.ReasoningEffortOverride != nil {
		mergeMap(m, map[string]any{"models": map[string]any{"default_reasoning_effort": *cfg.EngineOptions.ReasoningEffortOverride}})
	}
	effective, err := json.Marshal(m)
	if err != nil {
		return err
	}
	r.effective = string(effective)
	tree, err := toml.TreeFromMap(m)
	if err != nil {
		return err
	}
	data, err := tree.ToTomlString()
	if err != nil {
		return err
	}
	if err := AtomicWrite(filepath.Join(r.Home, "config.toml"), []byte(data), 0o600); err != nil {
		return err
	}
	if portal {
		hook := map[string]any{"hooks": map[string]any{"SessionStart": []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": shellQuote(executable) + " agent native-session"}}}}}}
		body, _ := json.Marshal(hook)
		return AtomicWrite(filepath.Join(r.Home, "hooks", "cxx-receiver.json"), body, 0o600)
	}
	return nil
}

func (r *Runtime) Environment(env []string) []string {
	out := make([]string, 0, len(env))
	for _, item := range env {
		key, _, _ := strings.Cut(item, "=")
		switch key {
		case "GROK_AUTH", "XAI_API_KEY", "GROK_API_KEY", "GROK_AUTH_PROVIDER_COMMAND", "GROK_AUTH_PATH", "GROK_HOME", "GROK_CONFIG", "GROK_CONFIG_PATH", "GROK_AUTH_EXPIRED", "CXX_GROK_SOCKET":
			continue
		}
		if strings.HasPrefix(key, "GROK_OIDC_") || strings.HasPrefix(key, "GROK_OAUTH2_") {
			continue
		}
		out = append(out, item)
	}
	out = SetEnv(out, "GROK_HOME", r.Home)
	out = SetEnv(out, "GROK_AUTH_PATH", r.AuthPath)
	out = SetEnv(out, AuthSocketEnv, r.Socket)
	if r.effective != "" {
		out = SetEnv(out, "GROK_CONFIG", r.effective)
	}
	out = SetEnv(out, "GROK_DISABLE_API_KEY_AUTH", "1")
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
		err := os.RemoveAll(r.Dir)
		if r.sessionLease != nil {
			err = errors.Join(err, r.sessionLease.Release())
			r.sessionLease = nil
		}
		return err
	}
	return nil
}

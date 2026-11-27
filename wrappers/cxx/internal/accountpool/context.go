// Package accountpool binds auth synchronization to one provider account.
// The binding contains identifiers only; credentials remain in native files.
package accountpool

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountgate"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/quotaemulation"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

type Client interface {
	JSON(context.Context, string, string, any, any, int) error
}
type Context struct {
	baseURL   string
	mu        sync.Mutex
	Engine    string
	ScopeID   string
	path      string
	AccountID int64
	SessionID string
	Capable   bool
	// AccountLabel, BindingGeneration and PendingSwitch follow the scope's
	// live binding (Claude live account switching). All guarded by mu.
	AccountLabel      string
	BindingGeneration int64
	PendingSwitch     *SwitchDirective
	// PoolSize is the engine's account count from the last verified answer
	// (0: unknown or a single account). Display only: the statusline names
	// the bound account when it is above one. poolKnown records that this
	// process observed it; until then a save keeps the binding file's hint,
	// which a sibling process may have refreshed since Load.
	PoolSize  int
	poolKnown bool
	wake      chan struct{}
	onAdopt   func(Adoption)
	// Pause, switch, resume (pause.go). gateDir is this launch's hook gate;
	// pause is the server's current command with its local deadline;
	// pauseCapable is what the server last said about this lease.
	gateDir       string
	pause         *PauseCommand
	pauseDeadline time.Time
	pauseChanged  chan struct{}
	pauseCapable  *bool
}

// binding is the scope's binding file. account_label and pool_size are
// display hints for the statusline; only account_id carries authority.
type binding struct {
	AccountID    int64  `json:"account_id"`
	AccountLabel string `json:"account_label,omitempty"`
	PoolSize     int    `json:"pool_size,omitempty"`
}

// leaseHeartbeatEvery renews a launch's account lease (server TTL 5 minutes).
var leaseHeartbeatEvery = 90 * time.Second

// A lost provider attachment is redialed every redialEvery; every
// redialsPerHeartbeat refusals in a row a heartbeat checks the lease itself.
var redialEvery = time.Second

const redialsPerHeartbeat = 30

func Load(engine, authPath, baseURL string) *Context {
	directory := filepath.Clean(filepath.Dir(authPath))
	if real, err := filepath.EvalSymlinks(directory); err == nil {
		directory = real
	}
	scope := sha256.Sum256([]byte(directory))
	server := sha256.Sum256([]byte(baseURL))
	c := &Context{baseURL: baseURL, Engine: engine, ScopeID: hex.EncodeToString(scope[:]), path: filepath.Join(filepath.Dir(authPath), ".cxx-account-"+hex.EncodeToString(server[:8])+".json")}
	if raw, err := os.ReadFile(c.path); err == nil {
		var b binding
		if json.Unmarshal(raw, &b) == nil {
			c.AccountID, c.AccountLabel, c.PoolSize = b.AccountID, b.AccountLabel, b.PoolSize
		}
	}
	return c
}

func (c *Context) Inject(path string, in any) any {
	if c == nil || (path != "/auth" && path != "/sync/bootstrap" && path != "/claude/usage/report") {
		return in
	}
	original, ok := in.(map[string]any)
	if !ok {
		return in
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	copied := make(map[string]any, len(original)+2)
	for k, v := range original {
		copied[k] = v
	}
	if c.AccountID > 0 {
		copied["account_id"] = c.AccountID
	}
	if c.SessionID != "" {
		copied["session_id"] = c.SessionID
	}
	return copied
}

// Observe accepts metadata only from a successful, verified auth response.
func (c *Context) Observe(path string, raw []byte) {
	if c == nil || (path != "/auth" && path != "/sync/bootstrap") {
		return
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(raw, &doc) != nil {
		return
	}
	if nested, ok := doc["data"]; ok {
		_ = json.Unmarshal(nested, &doc)
	}
	if path == "/sync/bootstrap" {
		_ = json.Unmarshal(doc["auth"], &doc)
	}
	var id int64
	var state string
	var capable bool
	_ = json.Unmarshal(doc["account_id"], &id)
	_ = json.Unmarshal(doc["verification_state"], &state)
	_ = json.Unmarshal(doc["account_pool"], &capable)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Capable = c.Capable || capable
	if c.SessionID != "" {
		var fields bindingFields
		_ = json.Unmarshal(doc["binding_generation"], &fields.BindingGeneration)
		fields.AccountSwitch = doc["account_switch"]
		fields.AccountID = id
		c.observeBindingLocked(fields, false)
	}
	if id <= 0 || state != "verified" || (c.SessionID != "" && c.AccountID != id) {
		return
	}
	// Live sessions of this scope own the binding; only a committed switch
	// (ApplySwitch or a fenced adoption) moves it. A process without a lease
	// must not rebind them from whatever account the server answered for.
	if c.SessionID == "" && c.AccountID > 0 && id != c.AccountID && len(c.LiveSessions()) > 0 {
		return
	}
	if id != c.AccountID {
		c.AccountLabel = ""
	}
	c.AccountID = id
	c.observePoolLocked(doc["quota_pool"])
	_ = c.saveLocked()
	c.cacheWeeklyLocked(doc)
}

// observePoolLocked records the pool size and the bound account's label from
// an answer's quota_pool, which the server sends only for more than one
// account; its absence means a single account (or no pool details).
func (c *Context) observePoolLocked(raw json.RawMessage) {
	var pool struct {
		Accounts []struct {
			ID    int64  `json:"id"`
			Label string `json:"label"`
		} `json:"accounts"`
	}
	c.poolKnown = true
	if len(raw) == 0 || json.Unmarshal(raw, &pool) != nil {
		c.PoolSize = 0
		return
	}
	c.PoolSize = len(pool.Accounts)
	for _, a := range pool.Accounts {
		if a.ID == c.AccountID && a.Label != "" {
			c.AccountLabel = a.Label
		}
	}
}

// notePoolLocked records that a switch or adoption proved a pool of at
// least two accounts.
func (c *Context) notePoolLocked() {
	if c.PoolSize < 2 {
		c.PoolSize, c.poolKnown = 2, true
	}
}

func (c *Context) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	if !c.poolKnown {
		if raw, err := os.ReadFile(c.path); err == nil {
			var b binding
			if json.Unmarshal(raw, &b) == nil {
				c.PoolSize = b.PoolSize
			}
		}
	}
	raw, err := json.Marshal(binding{AccountID: c.AccountID, AccountLabel: c.AccountLabel, PoolSize: c.PoolSize})
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(c.path), ".account-binding-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0o600); err == nil {
		_, err = f.Write(raw)
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, c.path)
}

type LeaseResponse struct {
	Usage               json.RawMessage          `json:"usage,omitempty"`
	KimiUsage           json.RawMessage          `json:"kimi_usage,omitempty"`
	QuotaSnapshot       *quotaemulation.Snapshot `json:"quota_snapshot,omitempty"`
	QuotaUnlimited      *bool                    `json:"quota_unlimited"`
	AccountID           int64                    `json:"account_id"`
	AccountLabel        string                   `json:"account_label"`
	SessionID           string                   `json:"session_id"`
	Auth                json.RawMessage          `json:"auth"`
	CanonicalDigest     string                   `json:"canonical_digest"`
	VerificationState   string                   `json:"verification_state"`
	CanonicalGeneration int64                    `json:"canonical_generation"`
	AccessTokenDigest   string                   `json:"access_token_digest"`
	AccessExpiresAt     string                   `json:"access_expires_at"`
	QuotaHardFail       *bool                    `json:"quota_hard_fail"`
	QuotaLimitPercent   *int                     `json:"quota_limit_percent"`
	QuotaWeekPartition  *int                     `json:"quota_week_partition"`
	// Live account switching (Claude). Absent on older servers.
	BindingGeneration    *int64          `json:"binding_generation"`
	AccountSwitch        json.RawMessage `json:"account_switch"`
	PreviousAccountID    int64           `json:"previous_account_id"`
	CanonicalLastRefresh string          `json:"canonical_last_refresh"`
}

// acquireLease retries only transient gateway failures. Reusing the original
// session ID makes a retry safe even if the server committed before disconnecting.
func acquireLease(ctx context.Context, client Client, body map[string]any, lease *LeaseResponse) error {
	for attempt := 0; ; attempt++ {
		err := client.JSON(ctx, http.MethodPost, "/auth/sessions", body, lease, 1)
		var status interface{ HTTPStatus() int }
		if err == nil || attempt >= 4 || !errors.As(err, &status) ||
			(status.HTTPStatus() != 502 && status.HTTPStatus() != 503 && status.HTTPStatus() != 504) {
			return err
		}
		timer := time.NewTimer(time.Second * time.Duration(1<<attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// Start reserves a choice before writing the native auth file. A local CAS
// failure aborts the launch instead of overwriting a login made during the call.
func (c *Context) Start(ctx context.Context, client Client, localActive bool, apply func(json.RawMessage, string, bool) (bool, error)) (func(), *LeaseResponse, error) {
	return c.StartWithCredentialCheck(ctx, client, localActive, apply, nil)
}

// StartWithCredentialCheck lets a launch join a live scope whose binding hint
// is stale. confirm must prove that the verified lease already matches the
// current native credentials, without replacing them. Other engines use Start.
func (c *Context) StartWithCredentialCheck(ctx context.Context, client Client, localActive bool, apply func(json.RawMessage, string, bool) (bool, error), confirm func(json.RawMessage, string) (bool, error)) (func(), *LeaseResponse, error) {
	if c == nil {
		return func() {}, nil, nil
	}
	c.mu.Lock()
	capable, current := c.Capable, c.AccountID
	c.mu.Unlock()
	if !capable {
		return func() {}, nil, nil
	}
	if localActive && current <= 0 && confirm == nil {
		return nil, nil, errors.New("cannot identify the account used by active native sessions")
	}
	rawID := make([]byte, 16)
	if _, err := rand.Read(rawID); err != nil {
		return nil, nil, err
	}
	id := hex.EncodeToString(rawID)
	body := map[string]any{"engine": c.Engine, "scope_id": c.ScopeID, "session_id": id}
	stateRequired := communicator.StateRequired(c.baseURL)
	if stateRequired {
		body["ownership_mode"] = "connection"
	}
	if localActive && current > 0 {
		body["account_id"] = current
	}
	var lease LeaseResponse
	if err := acquireLease(ctx, client, body, &lease); err != nil {
		return nil, nil, err
	}
	release := func() {
		queued, journalErr := communicator.QueueProviderRelease(c.baseURL, c.Engine, id)
		if journalErr != nil {
			fmt.Fprintln(os.Stderr, "cxx: provider release journal:", journalErr)
		}
		if queued && journalErr == nil {
			// The fsynced journal transfers this idempotent obligation to the
			// communicator. Its worker retries until acknowledged; a second
			// synchronous POST only races that worker and delays shell return.
			return
		}
		rctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := client.JSON(rctx, http.MethodPost, "/auth/sessions/release", map[string]any{"engine": c.Engine, "session_id": id}, nil, 0); err == nil && queued {
			communicator.AcknowledgeProviderRelease(c.baseURL, id)
		}
	}
	if lease.AccountID <= 0 || lease.SessionID != id || lease.VerificationState != "verified" || len(lease.Auth) == 0 {
		release()
		return nil, nil, errors.New("account assignment did not contain verified credentials")
	}
	switching := lease.AccountID != current
	var applied bool
	var err error
	if localActive && switching {
		if confirm != nil {
			applied, err = confirm(lease.Auth, lease.CanonicalDigest)
		}
		if !applied && err == nil {
			err = fmt.Errorf("account assignment would switch active local sessions: local binding #%d, lease #%d", current, lease.AccountID)
		}
	} else {
		applied, err = apply(lease.Auth, lease.CanonicalDigest, switching)
	}
	if err != nil || !applied {
		release()
		if err == nil {
			err = errors.New("local credentials changed during account assignment")
		}
		return nil, nil, err
	}
	// The file now holds the leased account's head, whatever it held before.
	c.ClearRepair()
	c.mu.Lock()
	c.AccountID, c.SessionID, c.AccountLabel = lease.AccountID, id, lease.AccountLabel
	c.observeBindingLocked(lease.binding(), false)
	err = c.saveLocked()
	c.mu.Unlock()
	if err != nil {
		release()
		return nil, nil, fmt.Errorf("save account binding: %w", err)
	}
	removeMarker := c.writeSessionMarker(id)
	removeGate := c.prepareGate(id)
	unmarkedRelease := release
	release = func() { removeGate(); removeMarker(); unmarkedRelease() }
	var initialState *communicator.StateClient
	if stateRequired {
		var stateErr error
		initialState, stateErr = communicator.DialState(ctx, c.baseURL, communicator.StateScope{Topic: "provider", ProviderSessionID: id, Engine: c.Engine}, communicator.StateAuth{})
		if stateErr != nil {
			release()
			return nil, nil, fmt.Errorf("provider owner attachment required: %w", stateErr)
		}
	}
	hctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		// A confirmed owner attachment replaces periodic lease renewal. Lost
		// authority retries only that attachment, never reassigning an account.
		connectionOwned := false
		refused := 0
		for {
			state := initialState
			initialState = nil
			var err error
			if state == nil {
				state, err = communicator.DialState(hctx, c.baseURL, communicator.StateScope{Topic: "provider", ProviderSessionID: id, Engine: c.Engine}, communicator.StateAuth{})
			}
			if err != nil {
				if !connectionOwned {
					break
				}
				// The server removes a lease whose holder was gone too long
				// (a suspended host) and then refuses the attachment for good.
				// A heartbeat finds that out (404) and re-reserves the same
				// session on the bound account; the next redial succeeds.
				if refused++; refused%redialsPerHeartbeat == 0 {
					_ = c.Heartbeat(hctx, client)
				}
				select {
				case <-hctx.Done():
					return
				case <-time.After(redialEvery):
				}
				continue
			}
			connectionOwned, refused = true, 0
			// The provider stream also carries the server's pause for this
			// lease. A lost stream keeps the last command: its local deadline
			// ends it, and the next snapshot says where the round stands.
		attached:
			for {
				var snapshot providerState
				_, changed, ok := state.Snapshot(&snapshot)
				if ok {
					c.observePause(snapshot.Pause, time.Now())
				}
				select {
				case <-hctx.Done():
					state.Close()
					return
				case <-state.Done():
					state.Close()
					break attached
				case <-changed:
				}
			}
		}
		// Three renewals per five-minute lease TTL; a missed one re-reserves on 404.
		ticker := time.NewTicker(leaseHeartbeatEvery)
		defer ticker.Stop()
		for {
			select {
			case <-hctx.Done():
				return
			case <-ticker.C:
				_ = c.Heartbeat(hctx, client)
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { cancel(); <-done; release() }) }, &lease, nil
}

// ActivateEnvironment matches the existing portal environment lifecycle. Only
// identifiers are inherited by the native CLI and its statusline subprocess.
func (c *Context) ActivateEnvironment() func() {
	if c == nil {
		return func() {}
	}
	c.mu.Lock()
	id, session, gate := c.AccountID, c.SessionID, c.gateDir
	c.mu.Unlock()
	// The launch's hooks find their gate through the environment; a launch
	// without one must not inherit the gate of the launch that started it.
	values := map[string]string{"CXX_PROVIDER_ACCOUNT_ID": strconv.FormatInt(id, 10), "CXX_PROVIDER_SESSION_ID": session, accountgate.EnvDir: gate}
	old := map[string]*string{}
	for key, value := range values {
		if previous, ok := os.LookupEnv(key); ok {
			copy := previous
			old[key] = &copy
		} else {
			old[key] = nil
		}
		_ = os.Setenv(key, value)
	}
	return func() {
		for key, value := range old {
			if value == nil {
				_ = os.Unsetenv(key)
			} else {
				_ = os.Setenv(key, *value)
			}
		}
	}
}

func AddEnvironmentBinding(body map[string]any) {
	id, err := strconv.ParseInt(os.Getenv("CXX_PROVIDER_ACCOUNT_ID"), 10, 64)
	if err == nil && id > 0 {
		body["account_id"] = id
	}
	if session := os.Getenv("CXX_PROVIDER_SESSION_ID"); session != "" {
		body["session_id"] = session
	}
}

// Binding returns a coherent identifier-only snapshot for the local communicator.
func (c *Context) Binding() (int64, string) {
	if c == nil {
		return 0, ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.AccountID, c.SessionID
}

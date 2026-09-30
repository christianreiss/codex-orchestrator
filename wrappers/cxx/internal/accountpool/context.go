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
	mu        sync.Mutex
	Engine    string
	ScopeID   string
	path      string
	AccountID int64
	SessionID string
	Capable   bool
}
type binding struct {
	AccountID int64 `json:"account_id"`
}

func Load(engine, authPath, baseURL string) *Context {
	directory := filepath.Clean(filepath.Dir(authPath))
	if real, err := filepath.EvalSymlinks(directory); err == nil {
		directory = real
	}
	scope := sha256.Sum256([]byte(directory))
	server := sha256.Sum256([]byte(baseURL))
	c := &Context{Engine: engine, ScopeID: hex.EncodeToString(scope[:]), path: filepath.Join(filepath.Dir(authPath), ".cxx-account-"+hex.EncodeToString(server[:8])+".json")}
	if raw, err := os.ReadFile(c.path); err == nil {
		var b binding
		if json.Unmarshal(raw, &b) == nil {
			c.AccountID = b.AccountID
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
	if id <= 0 || state != "verified" || (c.SessionID != "" && c.AccountID != id) {
		return
	}
	c.AccountID = id
	_ = c.saveLocked()
}

func (c *Context) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(binding{AccountID: c.AccountID})
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
	AccountID         int64           `json:"account_id"`
	AccountLabel      string          `json:"account_label"`
	SessionID         string          `json:"session_id"`
	Auth              json.RawMessage `json:"auth"`
	CanonicalDigest   string          `json:"canonical_digest"`
	VerificationState string          `json:"verification_state"`
}

// Start reserves a choice before writing the native auth file. A local CAS
// failure aborts the launch instead of overwriting a login made during the call.
func (c *Context) Start(ctx context.Context, client Client, localActive bool, apply func(json.RawMessage, string, bool) (bool, error)) (func(), *LeaseResponse, error) {
	if c == nil {
		return func() {}, nil, nil
	}
	c.mu.Lock()
	capable, current := c.Capable, c.AccountID
	c.mu.Unlock()
	if !capable {
		return func() {}, nil, nil
	}
	if localActive && current <= 0 {
		return nil, nil, errors.New("cannot identify the account used by active native sessions")
	}
	rawID := make([]byte, 16)
	if _, err := rand.Read(rawID); err != nil {
		return nil, nil, err
	}
	id := hex.EncodeToString(rawID)
	body := map[string]any{"engine": c.Engine, "scope_id": c.ScopeID, "session_id": id}
	if localActive && current > 0 {
		body["account_id"] = current
	}
	var lease LeaseResponse
	if err := client.JSON(ctx, http.MethodPost, "/auth/sessions", body, &lease, 1); err != nil {
		return nil, nil, err
	}
	release := func() {
		rctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = client.JSON(rctx, http.MethodPost, "/auth/sessions/release", map[string]any{"engine": c.Engine, "session_id": id}, nil, 0)
	}
	if lease.AccountID <= 0 || lease.SessionID != id || lease.VerificationState != "verified" || len(lease.Auth) == 0 {
		release()
		return nil, nil, errors.New("account assignment did not contain verified credentials")
	}
	if localActive && current > 0 && lease.AccountID != current {
		release()
		return nil, nil, errors.New("account assignment would switch active local sessions")
	}
	written, err := apply(lease.Auth, lease.CanonicalDigest, lease.AccountID != current)
	if err != nil || !written {
		release()
		if err == nil {
			err = errors.New("local credentials changed during account assignment")
		}
		return nil, nil, err
	}
	c.mu.Lock()
	c.AccountID, c.SessionID = lease.AccountID, id
	err = c.saveLocked()
	c.mu.Unlock()
	if err != nil {
		release()
		return nil, nil, fmt.Errorf("save account binding: %w", err)
	}
	hctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-hctx.Done():
				return
			case <-ticker.C:
				callCtx, stop := context.WithTimeout(hctx, 5*time.Second)
				_ = client.JSON(callCtx, http.MethodPost, "/auth/sessions/heartbeat", map[string]any{"engine": c.Engine, "session_id": id}, nil, 0)
				stop()
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
	id, session := c.AccountID, c.SessionID
	c.mu.Unlock()
	values := map[string]string{"CXX_PROVIDER_ACCOUNT_ID": strconv.FormatInt(id, 10), "CXX_PROVIDER_SESSION_ID": session}
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

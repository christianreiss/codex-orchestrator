package accountpool

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"
)

// SwitchDirective is the server's pending account change for this scope
// (`account_switch`). Its binding_generation is an opaque fence that is echoed
// verbatim when the switch is committed.
type SwitchDirective struct {
	AccountID         int64  `json:"account_id"`
	AccountLabel      string `json:"account_label"`
	BindingGeneration int64  `json:"binding_generation"`
	Reason            string `json:"reason"`
	RequestedAt       string `json:"requested_at"`
}

// Adoption reports that a sibling process in the same scope committed a switch.
// The sibling already wrote the native credentials; only identifiers changed.
type Adoption struct {
	PreviousAccountID int64
	AccountID         int64
	AccountLabel      string
}

// bindingFields are the scope metadata carried by acquire, heartbeat, /auth
// and /sync/bootstrap responses. A nil generation means an older server.
type bindingFields struct {
	AccountID         int64           `json:"account_id"`
	AccountLabel      string          `json:"account_label"`
	BindingGeneration *int64          `json:"binding_generation"`
	AccountSwitch     json.RawMessage `json:"account_switch"`
}

// observeBindingLocked is the single fencing rule for every response:
//   - a generation older than the known one is a stale response and ignored;
//   - a different account is adopted only with a strictly newer generation
//     and only where the caller permits adoption (heartbeat); otherwise the
//     response is ignored entirely so a later heartbeat can still adopt;
//   - a present `account_switch` replaces the pending directive (null clears
//     it); an absent key leaves it untouched. A directive naming the bound
//     account is nothing to do.
func (c *Context) observeBindingLocked(f bindingFields, allowAdopt bool) *Adoption {
	if f.BindingGeneration == nil {
		return nil
	}
	gen := *f.BindingGeneration
	if gen < c.BindingGeneration {
		return nil
	}
	var adopted *Adoption
	if f.AccountID > 0 && c.AccountID > 0 && f.AccountID != c.AccountID {
		if !allowAdopt || gen <= c.BindingGeneration {
			return nil
		}
		adopted = &Adoption{PreviousAccountID: c.AccountID, AccountID: f.AccountID, AccountLabel: f.AccountLabel}
		c.AccountID = f.AccountID
		c.AccountLabel = f.AccountLabel
		_ = c.saveLocked()
	} else if f.AccountID == c.AccountID && f.AccountLabel != "" {
		c.AccountLabel = f.AccountLabel
	}
	c.BindingGeneration = gen
	if len(f.AccountSwitch) > 0 {
		var directive *SwitchDirective
		if string(f.AccountSwitch) != "null" {
			var d SwitchDirective
			if json.Unmarshal(f.AccountSwitch, &d) == nil && d.AccountID > 0 && d.AccountID != c.AccountID {
				directive = &d
			}
		}
		c.PendingSwitch = directive
		if directive != nil {
			c.pokeLocked()
		}
	} else if adopted != nil && c.PendingSwitch != nil && c.PendingSwitch.AccountID == c.AccountID {
		c.PendingSwitch = nil
	}
	return adopted
}

func (c *Context) pokeLocked() {
	if c.wake == nil {
		c.wake = make(chan struct{}, 1)
	}
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// SwitchWake fires when a new directive arrives or a heartbeat is requested.
func (c *Context) SwitchWake() <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.wake == nil {
		c.wake = make(chan struct{}, 1)
	}
	return c.wake
}

// Poke asks the switch supervisor to heartbeat now (communicator push).
func (c *Context) Poke() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.pokeLocked()
	c.mu.Unlock()
}

// OnAdopt registers the callback run after a sibling's switch was adopted.
func (c *Context) OnAdopt(fn func(Adoption)) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.onAdopt = fn
	c.mu.Unlock()
}

func (c *Context) notifyAdopted(a *Adoption) {
	if a == nil {
		return
	}
	c.mu.Lock()
	fn := c.onAdopt
	c.mu.Unlock()
	if fn != nil {
		fn(*a)
	}
}

// Pending returns a copy of the pending directive, if any.
func (c *Context) Pending() *SwitchDirective {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.PendingSwitch == nil {
		return nil
	}
	copy := *c.PendingSwitch
	return &copy
}

// Label returns the bound account label known to this process.
func (c *Context) Label() string {
	if c == nil {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.AccountLabel
}

// DropPending forgets d when it is still the pending directive (stale commit).
func (c *Context) DropPending(d SwitchDirective) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.PendingSwitch != nil && c.PendingSwitch.AccountID == d.AccountID && c.PendingSwitch.BindingGeneration == d.BindingGeneration {
		c.PendingSwitch = nil
	}
}

// Heartbeat renews the lease and refreshes generation and directive. It is
// also the "heartbeat now" of a communicator push. A host that slept past the
// five-minute TTL resumes with a lease the server has already reaped while
// the native credentials still belong to the bound account, so a 404
// re-reserves the same session ID on the current account; the child's
// inherited session binding stays valid. Returned auth is discarded: the
// child may have rotated past it.
func (c *Context) Heartbeat(ctx context.Context, client Client) error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	id, account := c.SessionID, c.AccountID
	c.mu.Unlock()
	if id == "" {
		return nil
	}
	callCtx, stop := context.WithTimeout(ctx, 5*time.Second)
	var beat bindingFields
	err := client.JSON(callCtx, http.MethodPost, "/auth/sessions/heartbeat", map[string]any{"engine": c.Engine, "session_id": id}, &beat, 0)
	stop()
	if err == nil {
		c.mu.Lock()
		adopted := c.observeBindingLocked(beat, true)
		c.mu.Unlock()
		c.notifyAdopted(adopted)
		return nil
	}
	var status interface{ HTTPStatus() int }
	if !errors.As(err, &status) || status.HTTPStatus() != http.StatusNotFound {
		return err
	}
	callCtx, stop = context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	var lease LeaseResponse
	body := map[string]any{"engine": c.Engine, "scope_id": c.ScopeID, "session_id": id, "account_id": account}
	if err := client.JSON(callCtx, http.MethodPost, "/auth/sessions", body, &lease, 0); err != nil {
		return err
	}
	if lease.SessionID != id || lease.AccountID != account {
		_ = client.JSON(callCtx, http.MethodPost, "/auth/sessions/release", map[string]any{"engine": c.Engine, "session_id": id}, nil, 0)
		return errors.New("lease re-reservation returned another account")
	}
	c.mu.Lock()
	c.observeBindingLocked(lease.binding(), false)
	c.mu.Unlock()
	return nil
}

// ErrorCoder is implemented by orchestrator HTTP errors.
type ErrorCoder interface{ ErrorCode() string }

// SwitchErrorCode returns the machine code of a switch refusal, if any.
func SwitchErrorCode(err error) string {
	var coded ErrorCoder
	if errors.As(err, &coded) {
		return coded.ErrorCode()
	}
	return ""
}

// CommitSwitch performs the server half of a pending directive. Callers flush
// the old account first and write the returned credentials afterwards.
func (c *Context) CommitSwitch(ctx context.Context, client Client, d SwitchDirective) (*LeaseResponse, error) {
	c.mu.Lock()
	id := c.SessionID
	c.mu.Unlock()
	body := map[string]any{"engine": c.Engine, "session_id": id, "scope_id": c.ScopeID, "account_id": d.AccountID, "binding_generation": d.BindingGeneration}
	var out LeaseResponse
	if err := client.JSON(ctx, http.MethodPost, "/auth/sessions/switch", body, &out, 0); err != nil {
		return nil, err
	}
	if out.AccountID != d.AccountID || out.VerificationState != "verified" || len(out.Auth) == 0 {
		return nil, errors.New("account switch did not return verified credentials for the requested account")
	}
	return &out, nil
}

// ApplySwitch records a committed switch locally and returns the previous
// account. The binding file follows so statusline and siblings see it.
func (c *Context) ApplySwitch(res *LeaseResponse) (int64, string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	previous, label := c.AccountID, c.AccountLabel
	c.AccountID = res.AccountID
	c.AccountLabel = res.AccountLabel
	if res.BindingGeneration != nil && *res.BindingGeneration > c.BindingGeneration {
		c.BindingGeneration = *res.BindingGeneration
	}
	if c.PendingSwitch != nil && (c.PendingSwitch.AccountID == res.AccountID || c.PendingSwitch.BindingGeneration < c.BindingGeneration) {
		c.PendingSwitch = nil
	}
	return previous, label, c.saveLocked()
}

// SwitchRequestResult is the response of POST /auth/sessions/switch-request.
type SwitchRequestResult struct {
	BoundAccountID    int64            `json:"bound_account_id"`
	BindingGeneration int64            `json:"binding_generation"`
	AccountSwitch     *SwitchDirective `json:"account_switch"`
}

// RequestSwitch asks the server to set a desired account for the scope of
// sessionID. target is a positive account id or "auto".
func RequestSwitch(ctx context.Context, client Client, engine, sessionID string, target any, reason string) (*SwitchRequestResult, error) {
	switch v := target.(type) {
	case int64:
		if v <= 0 {
			return nil, errors.New("account id must be positive")
		}
	case string:
		if v != "auto" {
			return nil, errors.New(`target must be an account id or "auto"`)
		}
	default:
		return nil, errors.New(`target must be an account id or "auto"`)
	}
	if sessionID == "" {
		return nil, errors.New("no live session")
	}
	body := map[string]any{"engine": engine, "session_id": sessionID, "account_id": target, "reason": reason}
	var out SwitchRequestResult
	if err := client.JSON(ctx, http.MethodPost, "/auth/sessions/switch-request", body, &out, 0); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListAccounts reads GET /auth/accounts. sessionID is optional.
func ListAccounts(ctx context.Context, client Client, engine, sessionID string) (json.RawMessage, error) {
	query := url.Values{"engine": {engine}}
	if sessionID != "" {
		query.Set("session_id", sessionID)
	}
	var raw json.RawMessage
	if err := client.JSON(ctx, http.MethodGet, "/auth/accounts?"+query.Encode(), nil, &raw, 1); err != nil {
		return nil, err
	}
	return raw, nil
}

func (l *LeaseResponse) binding() bindingFields {
	return bindingFields{AccountID: l.AccountID, AccountLabel: l.AccountLabel, BindingGeneration: l.BindingGeneration, AccountSwitch: l.AccountSwitch}
}

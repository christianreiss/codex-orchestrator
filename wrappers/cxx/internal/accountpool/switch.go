package accountpool

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
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
	// BoundAccountUsable is false when the account the scope leaves is paused,
	// being removed or no longer verified, so its head cannot confirm a flush. Nil
	// (a server that does not say) means usable: the flush stays strict.
	BoundAccountUsable *bool `json:"bound_account_usable,omitempty"`
}

// LeavesUnusableAccount reports that the server declared the bound account
// unusable for this directive.
func (d SwitchDirective) LeavesUnusableAccount() bool {
	return d.BoundAccountUsable != nil && !*d.BoundAccountUsable
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
	// PauseCapable: the server counts this lease as able to pause (pause.go).
	// Absent on servers without pause rounds.
	PauseCapable *bool `json:"pause_capable"`
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
	if f.PauseCapable != nil {
		c.pauseCapable = f.PauseCapable
	}
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
		c.notePoolLocked()
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
	if communicator.StateRequired(c.baseURL) {
		// The lease was connection-owned; a timed one could not carry the
		// provider attachment this launch keeps redialing.
		body["ownership_mode"] = "connection"
	}
	if err := client.JSON(callCtx, http.MethodPost, "/auth/sessions", body, &lease, 0); err != nil {
		return err
	}
	if lease.SessionID != id || lease.AccountID != account {
		_ = client.JSON(callCtx, http.MethodPost, "/auth/sessions/release", map[string]any{"engine": c.Engine, "session_id": id}, nil, 0)
		return errors.New("lease re-reservation returned another account")
	}
	c.mu.Lock()
	// The server had no lease of this session left, so the generation it
	// answers with is the scope's current one, also when it is lower than
	// the one remembered here (a scope whose rows were all gone used to
	// start again at 1). Keeping the higher number would fence off every
	// later directive. A directive issued under the old count is void.
	if lease.BindingGeneration != nil && *lease.BindingGeneration < c.BindingGeneration {
		c.BindingGeneration = *lease.BindingGeneration
		c.PendingSwitch = nil
	}
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
	return c.commitSwitch(ctx, client, d, false)
}

// ReportUnfinishedSwitch repeats a commit the server already performed (it
// answers the repeat with the same credentials) and tells it that this host
// has not been able to write them, so the gap shows in the audit log.
func (c *Context) ReportUnfinishedSwitch(ctx context.Context, client Client, d SwitchDirective) error {
	_, err := c.commitSwitch(ctx, client, d, true)
	return err
}

func (c *Context) commitSwitch(ctx context.Context, client Client, d SwitchDirective, unfinished bool) (*LeaseResponse, error) {
	c.mu.Lock()
	id := c.SessionID
	c.mu.Unlock()
	body := map[string]any{"engine": c.Engine, "session_id": id, "scope_id": c.ScopeID, "account_id": d.AccountID, "binding_generation": d.BindingGeneration}
	if unfinished {
		body["credential_write"] = "unfinished"
	} else if pause, _, ok := c.Pause(time.Now()); ok && pause.Ready {
		// The commit happens inside a pause round; the server refuses it when
		// that round is over, because the sessions are then running again.
		body["pause_round"] = pause.Round
	}
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
	if previous != res.AccountID {
		c.notePoolLocked()
	}
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

// The repair flag marks a scope whose credentials file may not belong to the
// account the scope is bound to: a switch was committed and its write is
// outstanding, a sibling's switch was adopted unverified, or a sync found the
// file to be another account's login. It is a file next to the binding so it
// survives the process and reaches every wrapper of the scope. Only a write
// of the bound account's credentials, or a sync that finds them in place,
// clears it.
func (c *Context) repairPath() string {
	return strings.TrimSuffix(c.path, ".json") + ".repair"
}

// MarkRepair sets the repair flag. Best effort: without it the next sync
// still detects the mismatch.
func (c *Context) MarkRepair() {
	if c == nil || c.path == "" {
		return
	}
	if _, err := os.Stat(c.repairPath()); err == nil {
		return
	}
	_ = os.WriteFile(c.repairPath(), []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o600)
}

func (c *Context) RepairPending() bool {
	if c == nil || c.path == "" {
		return false
	}
	_, err := os.Stat(c.repairPath())
	return err == nil
}

func (c *Context) ClearRepair() {
	if c == nil || c.path == "" {
		return
	}
	_ = os.Remove(c.repairPath())
}

func (l *LeaseResponse) binding() bindingFields {
	return bindingFields{AccountID: l.AccountID, AccountLabel: l.AccountLabel, BindingGeneration: l.BindingGeneration, AccountSwitch: l.AccountSwitch}
}

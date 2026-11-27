package accountpool

import (
	"context"
	"errors"
	"net/http"
	"os"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountgate"
)

// PauseCommand is the server's pause for this lease: the server asks every
// session of a scope to hold itself at its hooks, switches the account once
// all of them report that they do, and then releases them. It travels in the
// snapshot of the lease's provider stream, so it reaches exactly this session.
type PauseCommand struct {
	// Round identifies one pause of the scope.
	Round string
	// HoldMS is how much longer the server lets the round run.
	HoldMS int64
	// Ready: every session of the scope reported that it is paused.
	Ready bool
}

// providerState is the part of the provider stream snapshot read here.
type providerState struct {
	Pause *providerPause `json:"pause"`
}

// providerPause is the pause as the server sends it. The deadline is the
// server's clock, so that the snapshot only changes when the round does.
type providerPause struct {
	Round    string `json:"round"`
	Deadline string `json:"deadline"`
	Ready    bool   `json:"ready"`
}

// command turns the server's deadline into the time left, measured on the
// server's clock as the stream last reported it. A pause this wrapper cannot
// read is no pause: nothing is held on a guess.
func (p *providerPause) command(serverNow time.Time) *PauseCommand {
	if p == nil || p.Round == "" {
		return nil
	}
	deadline, err := time.Parse(time.RFC3339, p.Deadline)
	if err != nil {
		return nil
	}
	left := deadline.Sub(serverNow)
	if left < 0 {
		left = 0
	}
	return &PauseCommand{Round: p.Round, HoldMS: left.Milliseconds(), Ready: p.Ready}
}

// observePause takes the pause of a provider snapshot (nil: none). The local
// deadline is fixed when a round is first seen and never moves out: hooks
// must not be held longer because a later snapshot was built later.
func (c *Context) observePause(cmd *PauseCommand, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if cmd == nil || cmd.Round == "" {
		if c.pause == nil {
			return
		}
		c.pause = nil
	} else {
		hold := time.Duration(cmd.HoldMS) * time.Millisecond
		if hold > accountgate.MaxHold {
			hold = accountgate.MaxHold
		}
		deadline := now.Add(hold)
		if c.pause != nil && c.pause.Round == cmd.Round {
			if c.pause.Ready == cmd.Ready {
				return
			}
			if c.pauseDeadline.Before(deadline) {
				deadline = c.pauseDeadline
			}
		}
		copy := *cmd
		c.pause, c.pauseDeadline = &copy, deadline
	}
	if c.pauseChanged != nil {
		close(c.pauseChanged)
	}
	c.pauseChanged = make(chan struct{})
	// The switch supervisor acts on a round that became ready.
	c.pokeLocked()
}

// Pause returns the server's pause for this lease and its local deadline.
// A round whose deadline has passed is over, whatever the server last said.
func (c *Context) Pause(now time.Time) (PauseCommand, time.Time, bool) {
	if c == nil {
		return PauseCommand{}, time.Time{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pause == nil || !now.Before(c.pauseDeadline) {
		return PauseCommand{}, time.Time{}, false
	}
	return *c.pause, c.pauseDeadline, true
}

// PauseChanged is closed when the pause of this lease changes.
func (c *Context) PauseChanged() <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pauseChanged == nil {
		c.pauseChanged = make(chan struct{})
	}
	return c.pauseChanged
}

// GateDir is where this launch's hooks coordinate a pause (accountgate).
// Empty when the launch has none.
func (c *Context) GateDir() string {
	if c == nil {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gateDir
}

// ScopeGates returns the gate directory of every live launch of the scope,
// this one included. A launch that has none (a wrapper without the gate)
// still gets its entry: the directory does not exist and is never safe.
func (c *Context) ScopeGates() []string {
	if c == nil {
		return nil
	}
	var dirs []string
	for _, m := range c.liveMarkers() {
		dirs = append(dirs, accountgate.Dir(c.markerDir(), m.SessionID))
	}
	return dirs
}

// ScopeSafe reports whether every live launch of the scope is paused for the
// round with no thread able to send a model request.
func (c *Context) ScopeSafe(round string, now time.Time) (bool, string) {
	dirs := c.ScopeGates()
	if len(dirs) == 0 {
		return false, "no live session marker"
	}
	for _, dir := range dirs {
		if safe, why := accountgate.Safe(dir, round, now); !safe {
			return false, why
		}
	}
	return true, ""
}

// PauseCapable is what the server last said about this lease: whether it
// counts it as able to pause. Unknown until a heartbeat answered.
func (c *Context) PauseCapable() (capable, known bool) {
	if c == nil {
		return false, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pauseCapable == nil {
		return false, false
	}
	return *c.pauseCapable, true
}

// Pause states a session reports (POST /auth/sessions/pause).
const (
	// PauseStateCapable: a hook of the launch has run, so the session can be
	// held. Sent without a round, once, and again after a re-reserved lease.
	PauseStateCapable = "capable"
	PauseStatePaused  = "paused"
	PauseStateRunning = "running"
	PauseStateDone    = "done"
	PauseStateFailed  = "failed"
)

// ReportPause tells the server where this session stands in a pause round.
func (c *Context) ReportPause(ctx context.Context, client Client, round, state, reason string) error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	id := c.SessionID
	c.mu.Unlock()
	if id == "" {
		return errors.New("no live session")
	}
	body := map[string]any{"engine": c.Engine, "session_id": id, "state": state}
	if round != "" {
		body["round"] = round
	}
	if reason != "" {
		if len(reason) > 300 {
			reason = reason[:300]
		}
		body["reason"] = reason
	}
	var beat bindingFields
	if err := client.JSON(ctx, http.MethodPost, "/auth/sessions/pause", body, &beat, 0); err != nil {
		return err
	}
	c.mu.Lock()
	if beat.PauseCapable != nil {
		c.pauseCapable = beat.PauseCapable
	}
	c.mu.Unlock()
	return nil
}

// ReportUnfinishedRepair tells the server that the scope's credentials file
// still does not belong to the account the scope is bound to, although no
// switch is pending any more (the directive is gone once the commit went
// through). It repeats the commit that led to the current binding, which the
// server answers as a replay; the server then knows the scope needs a quiet
// moment and can pause it.
func (c *Context) ReportUnfinishedRepair(ctx context.Context, client Client) error {
	c.mu.Lock()
	directive := SwitchDirective{AccountID: c.AccountID, BindingGeneration: c.BindingGeneration - 1}
	c.mu.Unlock()
	if directive.AccountID <= 0 || directive.BindingGeneration < 0 {
		return errors.New("no binding to report")
	}
	return c.ReportUnfinishedSwitch(ctx, client, directive)
}

// prepareGate gives a new Claude launch its gate directory.
func (c *Context) prepareGate(leaseID string) func() {
	if c.Engine != "claude" || !validSessionID(leaseID) {
		return func() {}
	}
	dir := accountgate.Dir(c.markerDir(), leaseID)
	if err := os.MkdirAll(c.markerDir(), 0o700); err != nil {
		return func() {}
	}
	if err := accountgate.Prepare(dir); err != nil {
		return func() {}
	}
	c.mu.Lock()
	c.gateDir = dir
	c.mu.Unlock()
	return func() {
		accountgate.Remove(dir)
		c.mu.Lock()
		c.gateDir = ""
		c.mu.Unlock()
	}
}

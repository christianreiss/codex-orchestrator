// Live Claude account switching inside a running session.
//
// The server keeps one desired account per scope (all sessions sharing
// ~/.claude). This supervisor learns about a pending directive (heartbeat
// poll, communicator push, /auth responses), waits for a turn boundary,
// flushes the old account's pending native rotation, commits the switch
// server-side and only then writes the new credentials. Claude Code reloads
// the credentials file when its mtime changes, before its next request.
package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
)

const (
	accountSwitchPollEvery  = 60 * time.Second
	accountSwitchGateEvery  = 5 * time.Second
	accountSwitchRetryEvery = 15 * time.Second
	accountSwitchMinBeat    = 2 * time.Second
	accountSwitchWrites     = 5
	// accountSwitchFinishTries bounds retries of a committed but unwritten
	// switch (about five minutes at the retry interval).
	accountSwitchFinishTries = 20
	accountAdoptSettle       = 10 * time.Second
)

var errTurnBusy = errors.New("a Claude turn started; credentials not written")

type switchOutcome int

const (
	switchRetry switchOutcome = iota
	switchDone
	switchDropped
	switchIncomplete
)

// switchPool is the slice of accountpool.Context the supervisor uses.
type switchPool interface {
	Pending() *accountpool.SwitchDirective
	DropPending(accountpool.SwitchDirective)
	SwitchWake() <-chan struct{}
}

// accountSwitchDeps isolates every step of a live switch, both for tests and
// so a transcript-resume fallback can replace performAccountSwitch without
// touching discovery or fencing.
type accountSwitchDeps struct {
	pool      switchPool
	heartbeat func(context.Context) error
	// idle reports that no Claude turn is running in this scope.
	idle func() bool
	// flush uploads any pending native rotation of the bound account and
	// returns the exact local generation the server has confirmed.
	flush  func(context.Context) (claude.AuthGeneration, error)
	commit func(context.Context, accountpool.SwitchDirective) (*accountpool.LeaseResponse, error)
	// apply records the committed switch locally (binding file, Context).
	apply func(*accountpool.LeaseResponse) (int64, string, error)
	// write stores the new credentials with a strict generation CAS while
	// no turn runs. It returns errTurnBusy when a turn started.
	write func(context.Context, *accountpool.LeaseResponse, claude.AuthGeneration) (claude.AuthGeneration, bool, error)
	// matches reports whether the local credentials already are res.Auth
	// (a concurrent sync materialized the committed head first).
	matches func(context.Context, *accountpool.LeaseResponse) (claude.AuthGeneration, bool)
	// pauseSync/resumeSync stop the background auth watcher across the
	// commit so it never runs with a half-switched binding.
	pauseSync  func()
	resumeSync func()
	done       func(previousID int64, previousLabel string, res *accountpool.LeaseResponse, generation claude.AuthGeneration, reason string)
	logger     *slog.Logger
	pollEvery  time.Duration
	gateEvery  time.Duration
	retryEvery time.Duration
}

// committedSwitch is a switch the server has committed (the directive is
// gone) whose credentials are not on disk yet. The supervisor keeps it and
// retries the write with background sync still paused, so the watcher never
// runs with the new binding over the old account's credentials for long.
type committedSwitch struct {
	res           *accountpool.LeaseResponse
	directive     accountpool.SwitchDirective
	expected      claude.AuthGeneration
	applied       bool
	previousID    int64
	previousLabel string
	attempts      int
}

// performAccountSwitch is the one place that performs a pending directive.
// Ordering: turn boundary, flush (old account confirmed), commit, write the
// new credentials, record the binding, notify. A rotation is never left
// unflushed: a CAS miss after the commit re-flushes and retries the write.
func performAccountSwitch(ctx context.Context, d *accountSwitchDeps, directive accountpool.SwitchDirective) (switchOutcome, *committedSwitch, error) {
	if !d.idle() {
		return switchRetry, nil, nil
	}
	expected, err := d.flush(ctx)
	if err != nil {
		return switchRetry, nil, fmt.Errorf("flush current account: %w", err)
	}
	if !d.idle() {
		return switchRetry, nil, nil
	}
	d.pauseSync()
	res, err := d.commit(ctx, directive)
	if err != nil {
		d.resumeSync()
		switch accountpool.SwitchErrorCode(err) {
		case "account_switch_stale", "account_switch_target_unavailable", "account_switch_unsupported_engine":
			d.pool.DropPending(directive)
			return switchDropped, nil, err
		}
		return switchRetry, nil, fmt.Errorf("commit account switch: %w", err)
	}
	return finishAccountSwitch(ctx, d, &committedSwitch{res: res, directive: directive, expected: expected})
}

// finishAccountSwitch writes committed credentials, then records the binding
// (always: the server already moved every lease of the scope) and notifies.
// Background sync stays paused while the write is outstanding.
func finishAccountSwitch(ctx context.Context, d *accountSwitchDeps, c *committedSwitch) (switchOutcome, *committedSwitch, error) {
	c.attempts++
	generation, written := writeCommittedSwitch(ctx, d, c)
	if !c.applied {
		previousID, previousLabel, err := d.apply(c.res)
		if err != nil {
			d.logger.Warn("account binding file not updated", "err", err)
		}
		c.applied, c.previousID, c.previousLabel = true, previousID, previousLabel
	}
	if !written {
		if ctx.Err() != nil {
			return switchIncomplete, nil, ctx.Err()
		}
		if c.attempts < accountSwitchFinishTries {
			return switchIncomplete, c, errors.New("account switch committed but the new credentials are not written yet; retrying")
		}
		d.resumeSync()
		return switchIncomplete, nil, errors.New("account switch committed but the new credentials could not be written; they arrive with the next idle sync or launch")
	}
	d.resumeSync()
	d.done(c.previousID, c.previousLabel, c.res, generation, c.directive.Reason)
	return switchDone, nil, nil
}

func writeCommittedSwitch(ctx context.Context, d *accountSwitchDeps, c *committedSwitch) (claude.AuthGeneration, bool) {
	if c.attempts > 1 {
		// Retrying later: wait for a quiet scope and confirm the current
		// local generation (it may hold a newer rotation of the old account).
		if !d.idle() {
			return claude.AuthGeneration{}, false
		}
		expected, err := d.flush(ctx)
		if err != nil {
			d.logger.Warn("re-flush before switched write failed", "err", err)
			return claude.AuthGeneration{}, false
		}
		c.expected = expected
	}
	for attempt := 0; attempt < accountSwitchWrites && ctx.Err() == nil; attempt++ {
		generation, written, err := d.write(ctx, c.res, c.expected)
		if written {
			return generation, true
		}
		if errors.Is(err, errTurnBusy) {
			if !sleepContext(ctx, d.gateEvery) {
				break
			}
			for !d.idle() && sleepContext(ctx, d.gateEvery) {
			}
			attempt--
			continue
		}
		if err != nil {
			d.logger.Warn("switched credentials not written", "err", err)
		}
		if current, ok := d.matches(ctx, c.res); ok {
			return current, true
		}
		// A native rotation landed after the flush: upload it before the
		// committed credentials may replace it.
		expected, err := d.flush(ctx)
		if err != nil {
			d.logger.Warn("re-flush before switched write failed", "err", err)
			if !sleepContext(ctx, d.gateEvery) {
				break
			}
			continue
		}
		c.expected = expected
	}
	return claude.AuthGeneration{}, false
}

func sleepContext(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// runAccountSwitcher polls for directives (pushes shorten the wait) and keeps
// retrying a pending one until it is done, dropped or replaced.
func runAccountSwitcher(ctx context.Context, d *accountSwitchDeps) {
	poll := time.NewTicker(d.pollEvery)
	defer poll.Stop()
	wake := d.pool.SwitchWake()
	var lastBeat time.Time
	// A committed switch still being written keeps sync paused; at exit the
	// launch stops the watcher for good and the post-run sync takes over.
	var committed *committedSwitch
	beat := func() {
		if time.Since(lastBeat) < accountSwitchMinBeat {
			return
		}
		lastBeat = time.Now()
		if err := d.heartbeat(ctx); err != nil {
			d.logger.Debug("account heartbeat failed", "err", err)
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-poll.C:
			beat()
		case <-wake:
			beat()
		}
		for ctx.Err() == nil && (committed != nil || d.pool.Pending() != nil) {
			var outcome switchOutcome
			var err error
			if committed != nil {
				outcome, committed, err = finishAccountSwitch(ctx, d, committed)
			} else {
				outcome, committed, err = performAccountSwitch(ctx, d, *d.pool.Pending())
			}
			if err != nil {
				d.logger.Warn("live account switch", "outcome", outcome, "err", err)
			}
			if outcome != switchRetry && committed == nil {
				break
			}
			wait := d.gateEvery
			if err != nil {
				wait = d.retryEvery
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			case <-poll.C:
				beat()
			case <-wake:
				beat()
			}
		}
	}
}

// restartableAuthWatch lets the switch supervisor re-register the mid-session
// auth watcher with the new account binding (the communicator job carries the
// account captured at registration).
type restartableAuthWatch struct {
	mu      sync.Mutex
	start   func() func()
	stop    func()
	paused  bool
	stopped bool
}

func (w *restartableAuthWatch) Start() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stop == nil && !w.stopped {
		w.stop = w.start()
	}
}

func (w *restartableAuthWatch) Pause() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stop != nil {
		w.stop()
		w.stop = nil
		w.paused = true
	}
}

// Resume restarts a paused watcher; Restart forces a fresh registration.
func (w *restartableAuthWatch) Resume() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.paused && !w.stopped {
		w.stop = w.start()
		w.paused = false
	}
}

func (w *restartableAuthWatch) Restart() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stop == nil || w.stopped {
		return
	}
	w.stop()
	w.stop = w.start()
}

// Stop ends the watcher for good (post-run upload follows).
func (w *restartableAuthWatch) Stop() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.stopped = true
	if w.stop != nil {
		w.stop()
		w.stop = nil
	}
}

func accountName(id int64, label string) string {
	label = strings.TrimSpace(label)
	if label == "" {
		return fmt.Sprintf("#%d", id)
	}
	return fmt.Sprintf("%s (#%d)", label, id)
}

// accountSwitchNotice is the model-facing text, delivered at the next prompt
// hook or agent MCP tool result like every credential notice.
func accountSwitchNotice(previousID int64, previousLabel string, nextID int64, nextLabel, reason string) string {
	if reason == "" {
		reason = "policy"
	}
	return fmt.Sprintf("The Claude account for this session was switched from %s to %s (reason: %s). Keep working; the next request runs on the new account and rebuilds the prompt cache once.",
		accountName(previousID, previousLabel), accountName(nextID, nextLabel), reason)
}

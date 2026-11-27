// Live Claude account switching inside a running session.
//
// The server keeps one desired account per scope (all sessions sharing
// ~/.claude). This supervisor learns about a pending directive (heartbeat
// poll, communicator push, /auth responses), waits for a turn boundary,
// flushes the old account's pending native rotation, commits the switch
// server-side and only then writes the new credentials. Claude Code reloads
// the credentials file when its mtime changes, before its next request.
//
// Commit and write are two steps on two machines. The server answers a
// repeated commit with the same credentials, and a repair flag next to the
// binding file is set before the commit and cleared by the write, so a lost
// answer, a killed process or a sibling that adopted the new binding all end
// in the same place: a supervisor of the scope writes the bound account's
// head at a turn boundary.
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
	// accountRepairReportAfter is how old the repair flag has to be before the
	// server is told that the credentials are not written. The flag is set
	// before every commit and on every adopted sibling switch and is normally
	// gone within seconds; a busy scope only delays the check that clears it.
	// Reporting a young flag told the server of a missing write after every
	// ordinary switch of a scope with several sessions.
	accountRepairReportAfter = 5 * time.Minute
	// accountSwitchBusyWait bounds one wait for a turn that started between
	// the commit and the write. Without a bound the supervisor sat in that
	// wait for as long as the scope stayed busy, never counted an attempt and
	// so never told the server that the credentials were not written.
	accountSwitchBusyWait = 60 * time.Second
)

var errTurnBusy = errors.New("a Claude turn started; credentials not written")

type switchOutcome int

const (
	switchRetry switchOutcome = iota
	switchDone
	switchDropped
	switchIncomplete
)

// flushResult is what the server confirmed about the local credentials.
type flushResult struct {
	// Generation is the exact local file with nothing left to upload.
	Generation claude.AuthGeneration
	// Bound is set when that file is a login of another account than the one
	// the server has this scope bound to: the bound account's verified head.
	Bound *accountpool.LeaseResponse
}

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
	// flush uploads any pending native rotation and returns the exact local
	// generation the server has confirmed. relaxed: the account being left
	// cannot confirm anything (paused, being removed, unverified); it is
	// enough that the server knows, accepted or refused the local file for good.
	flush  func(ctx context.Context, relaxed bool) (flushResult, error)
	commit func(context.Context, accountpool.SwitchDirective) (*accountpool.LeaseResponse, error)
	// report tells the server that a committed switch could not be written.
	report func(context.Context, accountpool.SwitchDirective) error
	// The repair flag of the scope (accountpool.Context.MarkRepair).
	markRepair    func()
	clearRepair   func()
	repairPending func() bool
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
	// Pause rounds (account_pause.go). All optional.
	// pauseRound returns the round the server asked this session to pause
	// for, and whether every session of the scope has reported paused.
	pauseRound func() (round string, ready bool)
	// pauseReport tells the server how the switch of a round ended.
	pauseReport func(ctx context.Context, round, state, reason string)
	// reportRepair repeats the unfinished report for a binding the file does
	// not follow, so the server can pause the scope for it. repairSince is
	// when the repair flag was set (zero: unknown, never reported).
	reportRepair func(context.Context) error
	repairSince  func() time.Time
	// repairReportAfter overrides accountRepairReportAfter (tests).
	repairReportAfter time.Duration
	logger            *slog.Logger
	pollEvery         time.Duration
	gateEvery         time.Duration
	retryEvery        time.Duration
	// busyWait overrides accountSwitchBusyWait (tests).
	busyWait time.Duration
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
	// repair: found by a sync, not committed by this supervisor. There is no
	// directive, and a later flush that finds no mismatch means it is done.
	repair bool
}

// performAccountSwitch is the one place that performs a pending directive.
// Ordering: turn boundary, flush (old account confirmed), commit, write the
// new credentials, record the binding, notify. A rotation is never left
// unflushed: a CAS miss after the commit re-flushes and retries the write.
func performAccountSwitch(ctx context.Context, d *accountSwitchDeps, directive accountpool.SwitchDirective) (switchOutcome, *committedSwitch, error) {
	if !d.idle() {
		return switchRetry, nil, nil
	}
	flushed, err := d.flush(ctx, directive.LeavesUnusableAccount())
	if err != nil {
		return switchRetry, nil, fmt.Errorf("flush current account: %w", err)
	}
	if !d.idle() {
		return switchRetry, nil, nil
	}
	d.pauseSync()
	// From here the server may hold the new binding while the file is still
	// the old account's, also when the answer is lost or this process dies.
	// The flag stays on a refusal too: an earlier attempt may have gone
	// through, and one sync that finds everything in place clears it.
	d.markRepair()
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
	return finishAccountSwitch(ctx, d, &committedSwitch{res: res, directive: directive, expected: flushed.Generation})
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
		if !c.repair {
			if err := d.report(ctx, c.directive); err != nil {
				d.logger.Warn("unfinished account switch not reported", "err", err)
			}
		}
		// The repair flag is still set: every poll tries again.
		return switchIncomplete, nil, errors.New("account switch committed but the new credentials could not be written; retrying at every poll")
	}
	d.clearRepair()
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
		flushed, err := d.flush(ctx, c.directive.LeavesUnusableAccount())
		if err != nil {
			d.logger.Warn("re-flush before switched write failed", "err", err)
			return claude.AuthGeneration{}, false
		}
		if c.reflushed(flushed) {
			return flushed.Generation, true
		}
	}
	var busy time.Duration
	for attempt := 0; attempt < accountSwitchWrites && ctx.Err() == nil; attempt++ {
		generation, written, err := d.write(ctx, c.res, c.expected)
		if written {
			return generation, true
		}
		if errors.Is(err, errTurnBusy) {
			limit := d.busyWait
			if limit <= 0 {
				limit = accountSwitchBusyWait
			}
			// Wait for the turn to end, but not for ever: past the limit the
			// attempt goes back to the caller, which counts it, retries later
			// and reports a write that never gets its turn.
			for waiting := true; waiting; waiting = !d.idle() {
				if busy += d.gateEvery; busy > limit {
					return claude.AuthGeneration{}, false
				}
				if !sleepContext(ctx, d.gateEvery) {
					return claude.AuthGeneration{}, false
				}
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
		flushed, err := d.flush(ctx, c.directive.LeavesUnusableAccount())
		if err != nil {
			d.logger.Warn("re-flush before switched write failed", "err", err)
			if !sleepContext(ctx, d.gateEvery) {
				break
			}
			continue
		}
		if c.reflushed(flushed) {
			return flushed.Generation, true
		}
	}
	return claude.AuthGeneration{}, false
}

// reflushed takes over a later flush and reports whether the write is already
// done. The server answers by its current binding: when it meanwhile serves a
// newer head, or the scope moved on to yet another account, that is what gets
// written. A repair ends when the server no longer sees a mismatch.
func (c *committedSwitch) reflushed(flushed flushResult) bool {
	c.expected = flushed.Generation
	if bound := flushed.Bound; bound != nil {
		next := *bound
		if next.AccountID == c.res.AccountID {
			if next.AccountLabel == "" {
				next.AccountLabel = c.res.AccountLabel
			}
			next.BindingGeneration = c.res.BindingGeneration
		} else {
			c.applied = false
		}
		c.res = &next
		return false
	}
	return c.repair
}

// repairOverdue reports that the repair flag is old enough to mean a write
// that is really outstanding.
func (d *accountSwitchDeps) repairOverdue() bool {
	if d.repairSince == nil {
		return false
	}
	since := d.repairSince()
	if since.IsZero() {
		return false
	}
	after := d.repairReportAfter
	if after <= 0 {
		after = accountRepairReportAfter
	}
	return time.Since(since) >= after
}

func (d *accountSwitchDeps) currentPauseRound() (string, bool) {
	if d.pauseRound == nil {
		return "", false
	}
	return d.pauseRound()
}

func (d *accountSwitchDeps) reportPause(ctx context.Context, round, state, reason string) {
	if d.pauseReport != nil && round != "" {
		d.pauseReport(ctx, round, state, reason)
	}
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
	var lastRepairReport time.Time
	// flushedRound is the pause round whose early flush has run.
	var flushedRound string
	// repair looks for a binding the credentials file does not follow yet: a
	// predecessor died between its commit and its write, a sibling's switch
	// was adopted, or a background sync saw another account's login.
	repair := func() *committedSwitch {
		if !d.repairPending() {
			return nil
		}
		if !d.idle() {
			// The scope is busy, so nothing can be checked. A flag that has
			// been there for minutes means the file has not followed its
			// binding for that long: the server hears it at every poll and
			// can pause the scope for the write. A young flag says nothing.
			if d.reportRepair != nil && d.repairOverdue() && time.Since(lastRepairReport) >= d.pollEvery {
				lastRepairReport = time.Now()
				if err := d.reportRepair(ctx); err != nil {
					d.logger.Debug("unfinished account repair not reported", "err", err)
				}
			}
			return nil
		}
		// Inside a ready pause round every session is held until somebody
		// says how it ended. This check is that somebody when there is no
		// directive: whatever it finds, the round must not run to its
		// deadline for nothing.
		round, ready := d.currentPauseRound()
		if !ready {
			round = ""
		}
		flushed, err := d.flush(ctx, false)
		if err != nil {
			d.logger.Debug("account repair check failed", "err", err)
			d.reportPause(ctx, round, accountpool.PauseStateFailed, "flush: "+err.Error())
			return nil
		}
		if flushed.Bound == nil {
			// The file already belongs to the bound account.
			d.clearRepair()
			d.reportPause(ctx, round, accountpool.PauseStateDone, "")
			return nil
		}
		d.pauseSync()
		return &committedSwitch{res: flushed.Bound, expected: flushed.Generation, repair: true,
			directive: accountpool.SwitchDirective{Reason: "an earlier switch whose credentials had not been written"}}
	}
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
		// Asked to pause: check the flush now, while the other sessions are
		// still coming to rest. A flush that cannot succeed ends the round at
		// once instead of holding every session for the whole budget.
		if round, ready := d.currentPauseRound(); round != "" && !ready && round != flushedRound && committed == nil {
			flushedRound = round
			if pending := d.pool.Pending(); pending != nil || d.repairPending() {
				relaxed := pending != nil && pending.LeavesUnusableAccount()
				if _, err := d.flush(ctx, relaxed); err != nil {
					d.logger.Warn("account pause: credentials cannot be flushed", "err", err)
					d.reportPause(ctx, round, accountpool.PauseStateFailed, "flush: "+err.Error())
				}
			}
		}
		if d.pool.Pending() == nil {
			committed = repair()
		}
		for ctx.Err() == nil && (committed != nil || d.pool.Pending() != nil) {
			var outcome switchOutcome
			var err error
			// The round this attempt runs in, if the scope is paused for one.
			round, ready := d.currentPauseRound()
			if !ready {
				round = ""
			}
			if committed != nil {
				outcome, committed, err = finishAccountSwitch(ctx, d, committed)
			} else {
				outcome, committed, err = performAccountSwitch(ctx, d, *d.pool.Pending())
			}
			if err != nil {
				d.logger.Warn("live account switch", "outcome", outcome, "err", err)
			}
			switch {
			case round == "":
			case outcome == switchDone:
				// Written: the server releases every session of the scope.
				d.reportPause(ctx, round, accountpool.PauseStateDone, "")
			case outcome == switchRetry && err != nil:
				// Flush or commit failed. Nobody else will finish this round,
				// so it ends now. A commit another session won (dropped) and a
				// write still being retried are not failures of the round.
				d.reportPause(ctx, round, accountpool.PauseStateFailed, err.Error())
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

// accountRepairNotice is the text when the credentials caught up with a
// binding this session already had.
func accountRepairNotice(id int64, label string) string {
	return fmt.Sprintf("The Claude credentials of this session were replaced by those of %s, the account it is bound to; an earlier account switch had not reached the credentials file. Keep working; the next request runs on that account and rebuilds the prompt cache once.",
		accountName(id, label))
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

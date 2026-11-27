// Pause, switch, resume: this session's part of a pause round.
//
// A live account switch needs a moment in which no session of the scope has
// a model request in flight. Waiting for that moment does not work on a busy
// host: with several agents it comes rarely or not at all. So the server asks
// for it. It sends a pause to every session of the scope (the snapshot of the
// lease's provider stream), each session holds itself at its next hook and
// reports back, and when all have reported the server marks the round ready.
// The switch supervisor then switches as it would in a natural gap, reports
// the outcome, and the server releases everyone.
//
// This file is the per-session agent: it turns the server's command into the
// hook gate of this launch (internal/accountgate) and reports what the hooks
// did. Nothing here decides anything about the account; a session that cannot
// pause in time simply does not report, and the server gives up the round.
package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountgate"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
)

const (
	// pauseWatchEvery is how often the hooks' phase files are read while a
	// round is active. Hooks are held for seconds; this only bounds how long
	// a paused session takes to say so.
	pauseWatchEvery = 150 * time.Millisecond
	// pauseIdleEvery is the pace without a round: it only decides when a
	// freshly gated launch announces itself.
	pauseIdleEvery = 5 * time.Second
	// pauseAnnounceEvery spaces repeated announcements (a lost answer, a
	// lease the server re-reserved without the flag).
	pauseAnnounceEvery = 60 * time.Second
)

// pausePool is the slice of accountpool.Context the agent uses.
type pausePool interface {
	Pause(now time.Time) (accountpool.PauseCommand, time.Time, bool)
	PauseChanged() <-chan struct{}
	GateDir() string
	PauseCapable() (capable, known bool)
}

type pauseAgentDeps struct {
	pool   pausePool
	report func(ctx context.Context, round, state, reason string) error
	logger *slog.Logger
	now    func() time.Time
	// watchEvery, idleEvery and announceEvery override the paces above (tests).
	watchEvery    time.Duration
	idleEvery     time.Duration
	announceEvery time.Duration
}

// runPauseAgent applies the server's pause to this launch's hook gate and
// reports the session's state for as long as the launch runs.
func runPauseAgent(ctx context.Context, d *pauseAgentDeps) {
	if d.now == nil {
		d.now = time.Now
	}
	watchEvery, idleEvery := d.watchEvery, d.idleEvery
	if watchEvery <= 0 {
		watchEvery = pauseWatchEvery
	}
	if idleEvery <= 0 {
		idleEvery = pauseIdleEvery
	}
	announceEvery := d.announceEvery
	if announceEvery <= 0 {
		announceEvery = pauseAnnounceEvery
	}
	var (
		round     string // the round the gate is active for
		reported  string // what the server was last told about that round
		announced time.Time
		// told: one announcement got through.
		told bool
		// unsupported: the server answered that it has no pause route.
		unsupported bool
	)
	release := func() {
		if round != "" {
			accountgate.Release(d.pool.GateDir())
			round, reported = "", ""
		}
	}
	defer release()
	for {
		dir := d.pool.GateDir()
		now := d.now()
		command, deadline, active := d.pool.Pause(now)
		if dir == "" || !active {
			release()
		} else {
			if command.Round != round {
				// A new round. The gate is written before the phases are
				// read below: see accountgate.Hook for why that order holds.
				if err := accountgate.Activate(dir, accountgate.Pause{Round: command.Round, Deadline: deadline}); err != nil {
					d.logger.Warn("account pause: gate not written", "err", err)
				} else {
					round, reported = command.Round, ""
					d.logger.Info("account pause requested by the server", "round", round, "hold", deadline.Sub(now).Round(time.Second))
				}
			}
			if round == command.Round {
				safe, why := accountgate.Safe(dir, round, d.now())
				switch {
				case safe && reported != accountpool.PauseStatePaused:
					if err := d.report(ctx, round, accountpool.PauseStatePaused, ""); err == nil {
						reported = accountpool.PauseStatePaused
					} else {
						d.logger.Debug("account pause: paused not reported", "err", err)
					}
				case !safe && reported == accountpool.PauseStatePaused:
					// A thread went on although the session had reported
					// paused (a hold that ran out). The server must not
					// switch on the earlier report.
					if err := d.report(ctx, round, accountpool.PauseStateRunning, why); err == nil {
						reported = accountpool.PauseStateRunning
					}
				}
			}
		}
		// A launch whose hooks have run can be paused. The server is told
		// once. It is told again when it says the lease is not capable: a
		// lease it re-reserved has lost the flag. A server that says nothing
		// (a lease that can never pause) is not asked twice.
		if !unsupported && dir != "" && accountgate.Ready(dir) && now.Sub(announced) >= announceEvery {
			if capable, known := d.pool.PauseCapable(); (!known && !told) || (known && !capable) {
				announced = now
				if err := d.report(ctx, "", accountpool.PauseStateCapable, ""); err == nil {
					told = true
				} else {
					// A server without pause rounds has no such route. It is
					// not asked again by this launch. A lease the server no
					// longer knows is a 404 too, and is asked again once the
					// heartbeat has taken it back.
					if routeMissing(err) {
						unsupported = true
					}
					d.logger.Debug("account pause: capability not announced", "err", err)
				}
			}
		}
		wait := idleEvery
		if round != "" {
			wait = watchEvery
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-d.pool.PauseChanged():
			timer.Stop()
		case <-timer.C:
		}
	}
}

// routeMissing reports that the server has no such route at all, as opposed
// to a route that answered "not found" for what was asked.
func routeMissing(err error) bool {
	var status interface{ HTTPStatus() int }
	if !errors.As(err, &status) {
		return false
	}
	if status.HTTPStatus() == 405 {
		return true
	}
	var message interface{ ServerMessage() string }
	return status.HTTPStatus() == 404 && errors.As(err, &message) && strings.Contains(message.ServerMessage(), "Route not found")
}

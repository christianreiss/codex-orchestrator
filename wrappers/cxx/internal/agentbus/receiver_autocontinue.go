package agentbus

import (
	"context"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

// The auto-continue ("AED") re-queues a prompt after a Codex turn dies on a
// transient provider capacity error ("Selected model is at capacity"). It only
// ever uses the attached TUI's own queue, like every other delivery, so the
// receiver never becomes a second scheduler.
const (
	capacityContinueMaxAttempts = 8
	capacityContinueBase        = 15 * time.Second
	capacityContinueCap         = 5 * time.Minute
	// A provider hint further out than this is an account limit, not a blip.
	capacityContinueHintLimit = 15 * time.Minute
	capacityContinuePrompt    = "The previous turn failed because the model was at capacity. Continue where you left off."
)

// capacityBackoff is the wait before the attempt-th (0-based) continue.
func capacityBackoff(attempt int) time.Duration {
	d := capacityContinueBase
	for i := 0; i < attempt && d < capacityContinueCap; i++ {
		d *= 2
	}
	if d > capacityContinueCap {
		d = capacityContinueCap
	}
	return d
}

type capacityContinuer struct {
	mu        sync.Mutex
	attempts  int
	armed     bool
	due       time.Time
	turnID    string
	completed string
}

// arm schedules a continue for the failed turn. It reports false once the
// attempt budget is spent or the provider asks for a longer wait, so the caller
// falls back to the watchdog path it used before.
func (c *capacityContinuer) arm(now time.Time, turnID, retryHint string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.attempts >= capacityContinueMaxAttempts {
		c.armed = false
		return false
	}
	due := now.Add(capacityBackoff(c.attempts))
	if retryHint != "" {
		if at, err := time.Parse(time.RFC3339, retryHint); err == nil {
			if at.Sub(now) > capacityContinueHintLimit {
				c.armed = false
				return false
			}
			if at.After(due) {
				due = at
			}
		}
	}
	c.armed, c.due, c.turnID = true, due, turnID
	return true
}

// noteCompleted resets the budget when the session completes a turn.
func (c *capacityContinuer) noteCompleted(turnID string) {
	if turnID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if turnID != c.completed {
		c.completed, c.attempts, c.armed = turnID, 0, false
	}
}

func (c *capacityContinuer) pending(now time.Time) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.turnID, c.armed && !now.Before(c.due)
}

func (c *capacityContinuer) fired() {
	c.mu.Lock()
	c.armed = false
	c.attempts++
	c.mu.Unlock()
}

func (c *capacityContinuer) cancel() {
	c.mu.Lock()
	c.armed = false
	c.mu.Unlock()
}

// capacityContinueGate lets the newest turn, thread status and queue admission
// be observed and used without widening nativeDelivery for the Claude path.
type capacityContinueGate interface {
	observeLatestFailure() (failure, retry string, transient bool, turnID string, err error)
	completedTurn() string
	latestTurnID() (id, status string, err error)
}

func (q *nativeQueue) completedTurn() string {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.lastCompletedTurn
}

func (q *nativeQueue) latestTurnID() (string, string, error) {
	turn, err := q.latestTurn()
	if err != nil || turn == nil {
		return "", "", err
	}
	return turn.ID, turn.Status, nil
}

// fireCapacityContinue queues the continue once it is due. It acts only while
// the failed turn is still the newest one (the user has not typed anything and
// nothing else started) and the thread is idle.
func (r *autoReceiver) fireCapacityContinue(ctx context.Context, now time.Time) error {
	turnID, ready := r.aed.pending(now)
	if !ready || ctx.Err() != nil {
		return nil
	}
	gate, ok := r.queue.(capacityContinueGate)
	if !ok || !r.capacityContinueOn() {
		r.aed.cancel()
		return nil
	}
	// A flaky read must not tear the receiver down; the next tick retries.
	id, status, err := gate.latestTurnID()
	if err != nil {
		return nil
	}
	if id != turnID || status != "failed" {
		r.aed.cancel()
		return nil
	}
	if state, err := r.queue.status(); err != nil || state != "idle" {
		return nil
	}
	// A failed admission still spends an attempt, so a broken queue cannot
	// loop forever; the budget then ends in the watchdog fallback.
	_ = r.queue.send(newUUID(), capacityContinuePrompt)
	r.aed.fired()
	return nil
}

// capacityContinueOn re-reads the signed host config on every use, like the
// broker's receiver gate, so an administrator revoking it needs no restart.
func (r *autoReceiver) capacityContinueOn() bool {
	if r.capacityContinueEnabled != nil {
		return r.capacityContinueEnabled()
	}
	path, err := config.DefaultPathForEngine(config.EngineCodex)
	if err != nil {
		return false
	}
	key, err := signing.PublicKey()
	if err != nil {
		return false
	}
	cfg, err := config.LoadForEngine(path, key, false, config.EngineCodex)
	return err == nil && cfg.AgentMessaging.Enabled && cfg.AgentMessaging.ReceiverEnabled && cfg.AgentMessaging.CapacityContinueEnabled
}

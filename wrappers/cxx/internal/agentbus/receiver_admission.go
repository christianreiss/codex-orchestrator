package agentbus

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"
)

func (p *channelPending) admissionPending() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.admission != nil
}

func (t *channelTracker) admissionIDs() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var ids []string
	for id, p := range t.items {
		if p.admissionPending() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// Only the original acceptance receipt is retried. The tracker survives a
// connection restart, but a lost MCP process may leave server work unknown:
// that never authorizes a fresh native invocation or a new claim identity.
func (r *autoReceiver) reconcileAdmissions(ctx context.Context) error {
	ids := r.tracker.admissionIDs()
	if len(ids) == 0 {
		return nil
	}
	r.mu.Lock()
	queue := r.queue
	r.mu.Unlock()
	if queue != nil {
		status, err := queue.status()
		if err != nil {
			return err
		}
		if status != "idle" {
			return nil
		}
	}
	for _, id := range ids {
		pending := r.tracker.get(id)
		if pending == nil {
			continue
		}
		if err := r.reconcileAdmission(ctx, id, pending); err != nil {
			return err
		}
	}
	return nil
}

func (r *autoReceiver) reconcileAdmission(ctx context.Context, id string, pending *channelPending) error {
	pending.opMu.Lock()
	defer pending.opMu.Unlock()
	if r.tracker.get(id) != pending {
		return nil
	}
	pending.mu.Lock()
	delivery := pending.admission
	pending.mu.Unlock()
	if delivery == nil {
		return nil
	}
	if err := r.tracker.acknowledge(ctx, id, pending, "accepted", ""); err != nil {
		// A rejected/expired claim cannot authorize native execution. Transient
		// failures retain the exact correlation; no listen may finish it unseen.
		if definitiveAdmissionError(err) {
			r.tracker.drop(id, pending)
		}
		return fmt.Errorf("delivery %s acceptance unconfirmed; no native submission: %w", id, err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Fence retry before touching the native adapter: a missing native receipt
	// must remain unknown, even if a reconnect follows immediately.
	pending.mu.Lock()
	pending.admission = nil
	pending.mu.Unlock()
	if err := r.deliver(id, nativePeerPrompt(delivery)); err != nil {
		_ = r.tracker.acknowledge(ctx, id, pending, "ambiguous", "native_submission_uncertain")
		r.tracker.drop(id, pending)
		return err
	}
	r.mu.Lock()
	native := r.queue != nil
	r.mu.Unlock()
	if native {
		r.tracker.markNativeDelivered(pending, time.Now())
		r.turnBusyAt, r.turnIdleSince = time.Time{}, time.Time{}
	}
	return nil
}

func definitiveAdmissionError(err error) bool {
	var api *APIError
	if errors.As(err, &api) && api.Code == "communicator_outcome_unknown" {
		return false
	}
	return definitiveChannelRenewalError(err)
}

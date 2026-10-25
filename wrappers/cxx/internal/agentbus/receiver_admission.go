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
	idle := r.nativeIdle()
	if queue != nil {
		status, err := queue.status()
		if err != nil {
			return err
		}
		idle = status == "idle"
	}
	for _, id := range ids {
		pending := r.tracker.get(id)
		if pending == nil {
			continue
		}
		r.mu.Lock()
		unsupported := r.immediateUnsupported
		r.mu.Unlock()
		if !idle && (!pending.immediate || unsupported) {
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
	if pending.immediate && pending.workKind != "" {
		return errors.New("immediate delivery cannot expose accepted work")
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
	r.mu.Lock()
	if pending.immediate {
		r.immediateUsed = true
	}
	r.mu.Unlock()
	var nativeTurn string
	var deliverErr error
	r.mu.Lock()
	guardedChannel := r.deliveryTimingV1 && r.queue == nil
	r.mu.Unlock()
	if guardedChannel {
		timing := "after_turn"
		if pending.immediate {
			timing = "immediate"
		}
		deliverErr = r.guardedChannelDelivery(ctx, id, nativePeerPrompt(delivery), timing)
	} else if pending.immediate && !r.nativeIdle() {
		nativeTurn, deliverErr = r.deliverImmediate(id, nativePeerPrompt(delivery))
	} else {
		deliverErr = r.deliver(id, nativePeerPrompt(delivery))
	}
	if err := deliverErr; err != nil {
		var nativeErr *nativeRPCError
		if pending.immediate && errors.As(err, &nativeErr) && nativeErr.code == -32601 {
			r.mu.Lock()
			r.immediateUnsupported = true
			r.lastTimingFallback = "native_immediate_unsupported"
			r.mu.Unlock()
			pending.mu.Lock()
			pending.admission = delivery
			pending.mu.Unlock()
			return errors.New("native immediate delivery unsupported; reconnecting to revoke capability")
		}
		var api *APIError
		if guardedChannel && errors.As(err, &api) && api.Code == "native_boundary_changed" {
			// The broker proves it rejected before the native write. Retain the
			// exact accepted claim; only this known non-submission may defer.
			pending.mu.Lock()
			pending.admission = delivery
			pending.mu.Unlock()
			return nil
		}
		_ = r.tracker.acknowledge(ctx, id, pending, "ambiguous", "native_submission_uncertain")
		r.tracker.drop(id, pending)
		return err
	}
	r.mu.Lock()
	native := r.queue != nil
	r.mu.Unlock()
	if native {
		r.tracker.mu.Lock()
		pending.nativeTurn = nativeTurn
		r.tracker.mu.Unlock()
		r.tracker.markNativeDelivered(pending, time.Now())
		if nativeTurn == "" {
			r.turnBusyAt, r.turnIdleSince = time.Time{}, time.Time{}
		}
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

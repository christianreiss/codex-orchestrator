package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// observeFailure separates accepted-work liveness from optional recovery.
// A failed native turn cannot keep renewing work forever merely because the
// interactive session and its MCP process remain open.
func (r *autoReceiver) observeFailure(ctx context.Context, nativeID string) error {
	var (
		failure, retry, turnID string
		transient              bool
		err                    error
	)
	if gate, ok := r.queue.(capacityContinueGate); ok {
		failure, retry, transient, turnID, err = gate.observeLatestFailure()
		r.aed.noteCompleted(gate.completedTurn())
	} else if observed, ok := r.queue.(interface {
		watchdogFailure() (string, string, error)
	}); ok {
		failure, retry, err = observed.watchdogFailure()
	} else {
		return nil
	}
	if err != nil || failure == "" {
		return err
	}
	var policy struct {
		Watchdog json.RawMessage `json:"watchdog"`
	}
	protected := r.client.post(ctx, "watchdog/get", map[string]any{}, &policy) == nil && len(policy.Watchdog) > 0 && string(policy.Watchdog) != "null"
	// While the auto-continue is retrying, the watchdog only gets a progress
	// ping: a capacity failure would let the server terminate and resume the
	// child underneath the retry. Exhaustion reports the failure as before.
	retrying := failure == "capacity" && transient && r.capacityContinueOn() && r.aed.arm(time.Now(), turnID, retry)
	if protected || failure == "capacity" || failure == "user_stop" || failure == "blocked" {
		body := map[string]any{"last_progress_at": time.Now().UTC().Format(time.RFC3339Nano), "native_session_id": nativeID}
		if !retrying {
			body["failure"] = failure
			if retry != "" {
				body["retry_not_before"] = retry
			}
		}
		_ = r.client.sessionPost(ctx, "watchdog/activity", body, nil)
	}
	return r.tracker.abandonFailedTurn(ctx, failure)
}

func (t *channelTracker) abandonFailedTurn(ctx context.Context, failure string) error {
	t.mu.Lock()
	pending := make(map[string]*channelPending, len(t.items))
	for id, item := range t.items {
		pending[id] = item
	}
	t.mu.Unlock()
	var result error
	for id, item := range pending {
		item.opMu.Lock()
		// An explicit result already being stored outranks inferred failure.
		if t.get(id) == item && !item.admissionPending() && item.completion() == nil && item.reply() == nil {
			item.cancel()
			code := "native_turn_failed"
			if failure == "user_stop" {
				code = "native_turn_interrupted"
			}
			result = errors.Join(result, t.acknowledge(ctx, id, item, "ambiguous", code))
			// Even an unavailable server must no longer receive renewals. Its
			// lease expiry remains the fallback for an uncertain ACK response.
			t.drop(id, item)
		}
		item.opMu.Unlock()
	}
	return result
}

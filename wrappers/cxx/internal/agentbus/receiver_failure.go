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
	observed, ok := r.queue.(interface {
		watchdogFailure() (string, string, error)
	})
	if !ok {
		return nil
	}
	var policy struct {
		Watchdog json.RawMessage `json:"watchdog"`
	}
	protected := r.client.post(ctx, "watchdog/get", map[string]any{}, &policy) == nil && len(policy.Watchdog) > 0 && string(policy.Watchdog) != "null"
	failure, retry, err := observed.watchdogFailure()
	if err != nil || failure == "" {
		return err
	}
	if protected || failure == "capacity" || failure == "user_stop" || failure == "blocked" {
		body := map[string]any{"last_progress_at": time.Now().UTC().Format(time.RFC3339Nano), "failure": failure, "native_session_id": nativeID}
		if retry != "" {
			body["retry_not_before"] = retry
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
		if t.get(id) == item && item.completion() == nil && item.reply() == nil {
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

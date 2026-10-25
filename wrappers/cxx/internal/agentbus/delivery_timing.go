package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
	"net/http"
	"time"
)

func deliveryTimingProperty() map[string]any {
	return map[string]any{"type": "string", "enum": []string{"immediate", "after_turn"}, "default": "after_turn", "description": "Informational delivery timing: immediate inserts at a supported native boundary during current work without cancellation; after_turn waits for idle."}
}

func copyDeliveryTiming(args, body map[string]any, work bool) error {
	v, exists := args["delivery_timing"]
	if !exists {
		return nil
	}
	timing, ok := v.(string)
	if !ok || (timing != "immediate" && timing != "after_turn") {
		return errors.New("delivery_timing must be immediate or after_turn")
	}
	if work && timing == "immediate" {
		return errors.New("immediate delivery is informational only; work must use after_turn")
	}
	body["delivery_timing"] = timing
	return nil
}

func immediateInformation(d map[string]any) bool {
	if stringArg(d, "delivery_timing") != "immediate" || stringArg(d, "work_kind") != "" {
		return false
	}
	switch stringArg(d, "kind") {
	case "message", "reply", "publication":
		return true
	}
	return false
}

// An adapter must opt in explicitly. Generic queue admission never implies
// permission to interrupt a native turn or create a second one.
type nativeImmediateDelivery interface {
	sendImmediate(string, string) (string, error)
}

func (r *autoReceiver) immediateClaimAllowed(gate string) bool {
	r.mu.Lock()
	enabled, queue := r.deliveryTimingV1, r.queue
	activity := claudeTurnState(r.claudeActivity)
	used, unsupported := r.immediateUsed, r.immediateUnsupported
	r.mu.Unlock()
	if !enabled || used || unsupported || (gate == "open" || gate == "work_active") {
		return false
	}
	if queue != nil {
		if _, ok := queue.(nativeImmediateDelivery); !ok {
			return false
		}
	} else if activity != "working" {
		return false
	}
	r.tracker.mu.Lock()
	defer r.tracker.mu.Unlock()
	for _, pending := range r.tracker.items {
		if pending.immediate {
			return false
		}
	}
	return true
}

func (r *autoReceiver) deliverImmediate(id, content string) (string, error) {
	r.mu.Lock()
	queue := r.queue
	activity := claudeTurnState(r.claudeActivity)
	r.mu.Unlock()
	if queue != nil {
		adapter, ok := queue.(nativeImmediateDelivery)
		if !ok {
			return "", errors.New("native adapter does not support immediate delivery")
		}
		return adapter.sendImmediate(id, content)
	}
	if activity != "working" {
		return "", errors.New("immediate channel delivery requires active native activity proof")
	}
	return "", r.deliver(id, content)
}

// A steering receipt proves admission to this turn. Only that exact turn's
// terminal status can complete it automatically; queue admission or an unrelated
// idle observation cannot prove consumption.
func (r *autoReceiver) releaseCompletedImmediate(ctx context.Context) error {
	r.mu.Lock()
	queue, ok := r.queue.(*nativeQueue)
	r.mu.Unlock()
	if !ok {
		return nil
	}
	r.tracker.mu.Lock()
	ids := map[string]string{}
	for id, pending := range r.tracker.items {
		if pending.nativeTurn != "" && pending.workKind == "" {
			ids[id] = pending.nativeTurn
		}
	}
	r.tracker.mu.Unlock()
	if len(ids) == 0 {
		return nil
	}
	turn, err := queue.latestTurn()
	if err != nil || turn == nil {
		return err
	}
	if turn.Status != "completed" {
		return nil
	}
	var seen []string
	for id, target := range ids {
		if target == turn.ID {
			seen = append(seen, id)
		}
	}
	_, err = r.tracker.releaseSeen(ctx, seen)
	return err
}

func (r *autoReceiver) nativeIdle() bool {
	r.mu.Lock()
	queue := r.queue
	activity := claudeTurnState(r.claudeActivity)
	enabled := r.deliveryTimingV1
	r.mu.Unlock()
	if queue != nil {
		status, err := queue.status()
		return err == nil && status == "idle"
	}
	return !enabled || activity == "idle"
}

const ownerDeliverPath = "/turn/deliver"

// Only the broker calls this endpoint while holding the native hook ordering
// lock. No broker RPC is allowed here: that would deadlock the guard.
func (o *receiverOwner) serveChannelDelivery(w http.ResponseWriter, req *http.Request) {
	var input struct {
		SessionID       string `json:"session_id"`
		NativeID        string `json:"native_session_id"`
		MessageID       string `json:"message_id"`
		Content         string `json:"content"`
		WriteDeadlineMS int64  `json:"write_deadline_ms"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, req.Body, 2<<20)).Decode(&input) != nil || input.SessionID != o.client.id {
		http.Error(w, "invalid channel delivery", 400)
		return
	}
	r := o.tracker.receiver
	if r == nil {
		http.Error(w, "receiver unavailable", 409)
		return
	}
	r.mu.Lock()
	nativeID, queue, output := r.nativeDeliveryID, r.queue, r.output
	r.mu.Unlock()
	pending := o.tracker.get(input.MessageID)
	if queue != nil || nativeID != input.NativeID || pending == nil || pending.admissionPending() || output == nil {
		http.Error(w, "channel delivery ownership changed", 409)
		return
	}
	attempted, err := output.sendGuarded(req.Context(), time.UnixMilli(input.WriteDeadlineMS), map[string]any{"jsonrpc": "2.0", "method": "notifications/claude/channel", "params": map[string]any{"content": input.Content, "meta": map[string]string{"message_id": input.MessageID}}})
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		if !attempted {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{"message_id": input.MessageID, "error": map[string]any{"code": "native_boundary_changed"}})
		} else {
			w.WriteHeader(http.StatusBadGateway)
			_ = json.NewEncoder(w).Encode(map[string]any{"message_id": input.MessageID, "error": map[string]any{"code": "native_submission_uncertain"}})
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"delivered": true, "message_id": input.MessageID})
}

func (r *autoReceiver) guardedChannelDelivery(ctx context.Context, id, content, timing string) error {
	r.mu.Lock()
	nativeID := r.nativeDeliveryID
	r.mu.Unlock()
	var out struct {
		Delivered bool                         `json:"delivered"`
		TurnProof *agentportal.ClaudeTurnProof `json:"turn_proof"`
	}
	err := r.client.receiver(ctx, "channel-deliver", map[string]any{"native_session_id": nativeID, "message_id": id, "content": content, "delivery_timing": timing}, &out)
	if timing == "immediate" {
		proof := out.TurnProof
		valid := proof != nil && proof.Epoch != "" && proof.Sequence > 0 && proof.NativeInstanceID != "" && proof.BindingGeneration > 0
		if !valid {
			proof = nil
		}
		r.finishClaudeImmediateBudget(proof)
		if err == nil && !valid {
			return errors.New("guarded immediate channel admission proof missing")
		}
	}
	if err != nil {
		return err
	}
	if !out.Delivered {
		return errors.New("channel admission receipt missing")
	}
	return nil
}

func claudeTurnState(a activityObservation) string {
	if a.TurnProof == nil {
		return "unknown"
	}
	switch a.TurnProof.State {
	case "idle":
		return "idle"
	case "active":
		return "working"
	}
	return "unknown"
}

// Empty required params are a passive method-parser probe, never a valid
// invocation. Only a recognized required-field parser rejection proves the method exists; timeout, unknown
// method, arbitrary errors and a surprising success all fail closed.
func probeImmediateMethod(call func(string, any, any) error, method string) bool {
	var ignored map[string]any
	err := call(method, map[string]any{}, &ignored)
	var rpc *nativeRPCError
	if !errors.As(err, &rpc) || (method != "turn/steer" && method != "_x.ai/interject") {
		return false
	}
	if rpc.code == -32602 {
		return true
	}
	// Actual Codex 0.164 returns InvalidRequest for the empty-params
	// deserialization probe. Recognize only this observed parser diagnostic,
	// never an arbitrary InvalidRequest or another method's error.
	return method == "turn/steer" && rpc.method == method && rpc.code == -32600 && rpc.message == "Invalid request: missing field `threadId`"
}

func (r *autoReceiver) timingNativeReady(ctx context.Context) bool {
	r.mu.Lock()
	queue := r.queue
	r.mu.Unlock()
	switch q := queue.(type) {
	case *nativeQueue:
		return probeImmediateMethod(q.call, "turn/steer")
	case *grokQueue:
		q.mu.Lock()
		defer q.mu.Unlock()
		return probeImmediateMethod(q.call, "_x.ai/interject")
	case nil:
		r.mu.Lock()
		output := r.output
		r.mu.Unlock()
		if !output.supportsGuardedWrite() {
			return false
		}
		var a activityObservation
		if r.client.receiver(ctx, "activity-hook", map[string]any{"native_session_id": r.boundNativeID}, &a) != nil {
			return false
		}
		r.mu.Lock()
		r.claudeActivity = a
		r.mu.Unlock()
		return a.TurnProof != nil && a.TurnProof.Epoch != "" && a.TurnProof.NativeInstanceID != "" && a.TurnProof.BindingGeneration > 0
	}
	return false
}

// A new owner cannot know whether a previous process already used this turn's
// slot. Warm up conservatively at a newly observed idle boundary; reconnects on
// this receiver preserve the existing budget.
func (r *autoReceiver) initializeImmediateBudget() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.immediateBudgetInitialized {
		r.immediateBudgetInitialized = true
		r.immediateUsed = true
	}
}
func (r *autoReceiver) observeClaudeTurn(a activityObservation) {
	r.mu.Lock()
	defer r.mu.Unlock()
	proof := a.TurnProof
	if proof != nil && r.claudeActivity.TurnProof != nil && proof.Epoch == r.claudeActivity.TurnProof.Epoch && proof.Sequence < r.claudeActivity.TurnProof.Sequence {
		return
	}
	r.claudeActivity = a
	if proof == nil {
		return
	}
	if !r.immediateBudgetProofKnown || proof.Epoch != r.immediateBudgetEpoch {
		r.immediateUsed = true
		r.immediateBudgetEpoch = proof.Epoch
		r.immediateBudgetSequence = proof.Sequence
		r.immediateBudgetProofKnown = true
		return
	}
	if proof.State == "active" && r.immediateUsed && proof.Sequence > r.immediateBudgetSequence {
		r.immediateBudgetSequence = proof.Sequence
	}
	if proof.State == "idle" && proof.Sequence > r.immediateBudgetSequence {
		r.immediateUsed = false
		r.immediateBudgetEpoch = proof.Epoch
		r.immediateBudgetSequence = proof.Sequence
	}
}

func (r *autoReceiver) finishClaudeImmediateBudget(proof *agentportal.ClaudeTurnProof) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.immediateUsed = true
	if proof == nil {
		r.immediateBudgetProofKnown = false
		return
	}
	if proof != nil {
		r.immediateBudgetEpoch = proof.Epoch
		r.immediateBudgetSequence = proof.Sequence
		r.immediateBudgetProofKnown = true
	}
}

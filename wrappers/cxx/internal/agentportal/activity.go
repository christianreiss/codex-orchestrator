package agentportal

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"time"
)

// ActivityObservation contains metadata only, never prompt or tool contents.
type ActivityObservation struct {
	State         string           `json:"state"`
	TurnProof     *ClaudeTurnProof `json:"turn_proof,omitempty"`
	WaitReason    *string          `json:"wait_reason"`
	Source        string           `json:"source"`
	EvidenceAgeMS int64            `json:"evidence_age_ms"`
}

type ActivityHook struct {
	NativeID string `json:"native_session_id"`
	Event    string `json:"event"`
	Tool     string `json:"tool,omitempty"`
	// Source is SessionStart's startup|resume|clear|compact; empty elsewhere.
	Source string `json:"source,omitempty"`
	// Observer marks a poll from the receiver's activity loop, the one reader that
	// pins its first sequence and reports to the server.
	Observer bool `json:"observer,omitempty"`
}

func ClaudeActivity(h ActivityHook) ActivityObservation {
	a := ActivityObservation{State: "unknown", Source: "claude-hooks"}
	waiting := func(reason string) { a.State = "waiting"; a.WaitReason = &reason }
	switch h.Event {
	case "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "ElicitationResult":
		a.State = "working"
	case "PreToolUse":
		a.State = "working"
		if h.Tool == "AskUserQuestion" {
			waiting("input")
		}
	case "PermissionRequest":
		waiting("approval")
	case "Elicitation":
		waiting("input")
	case "Stop", "StopFailure":
		a.State = "idle"
	}
	return a
}

// The existing private broker is the hook collector. Hooks never wait on the server.
func (b *Broker) activityHook(w http.ResponseWriter, raw []byte) {
	var h ActivityHook
	if json.Unmarshal(raw, &h) != nil {
		writeBrokerError(w, 400, "activity_hook_invalid", "Invalid hook")
		return
	}
	b.nativeMu.Lock()
	defer b.nativeMu.Unlock()
	if h.Event != "" {
		if b.session.Engine != "claude" || h.NativeID == "" || h.NativeID != b.nativeID {
			writeBrokerError(w, 409, "activity_hook_stale", "Native identity changed")
			return
		}
		b.hookActivity = ClaudeActivity(h)
		b.hookActivityAt = time.Now()
		b.hookActivityNativeID = h.NativeID
	}
	instance, binding := b.nativeTurnIdentity()
	// No turn has been observed in this epoch (or the idle boundary is already
	// armed): the only state a SessionStart may legitimately turn into idle.
	quiet := b.turnProof.Epoch == "" || b.turnProofNativeID != b.nativeID || b.turnProof.Sequence <= 1 || b.sessionIdle > 0
	proof := b.updateClaudeTurnProof(h.NativeID, instance, binding, h.Event)
	proof = b.advanceSessionIdle(h, proof, instance, binding, quiet)
	a := b.hookActivity
	if b.hookActivityAt.IsZero() || b.hookActivityNativeID != b.nativeID || (h.NativeID != "" && h.NativeID != b.nativeID) {
		a = ActivityObservation{State: "unknown", Source: "claude-hooks"}
	} else {
		a.EvidenceAgeMS = time.Since(b.hookActivityAt).Milliseconds()
		if a.EvidenceAgeMS >= 45000 {
			a.State = "unknown"
			a.WaitReason = nil
		}
		if a.EvidenceAgeMS > 86400000 {
			a.EvidenceAgeMS = 86400000
		}
	}
	a.TurnProof = &proof
	_ = json.NewEncoder(w).Encode(a)
}

// ClaudeActiveStaleAfter bounds how long an `active` turn proof may hold back
// default (after_turn) deliveries without any new native hook evidence. Claude
// Code queues channel notifications natively and presents them in order, so a
// delivery written into a turn that is in fact still running is not lost; a
// proof stuck `active` because a Stop never fired (Esc interrupt, crash,
// dropped hook) would otherwise close reception for good.
const ClaudeActiveStaleAfter = 10 * time.Minute

// ClaudeTurnBusy reports whether a turn proof is positive, fresh evidence that
// the root turn is still running. Only that may defer a channel write: unknown
// (reconnect, reset, observer restart) and stale active fail open, because the
// native channel queue already serializes delivery with the running turn.
func ClaudeTurnBusy(proof *ClaudeTurnProof, evidenceAge time.Duration) bool {
	return proof != nil && proof.State == "active" && evidenceAge < ClaudeActiveStaleAfter
}

// ClaudeTurnProof is lifecycle order, separate from expiring activity telemetry.
// Sequence one is the unknown epoch bootstrap; only an observed Stop is idle.
type ClaudeTurnProof struct {
	Epoch             string `json:"epoch"`
	Sequence          uint64 `json:"sequence"`
	State             string `json:"state"`
	NativeInstanceID  string `json:"native_instance_id"`
	BindingGeneration int    `json:"binding_generation"`
}

// turnSessionIdle is the lifecycle event that marks a session sitting at its
// first idle prompt. No Stop ever announces it, so a session that has not yet
// received a message would stay `unknown` and claim nothing.
const turnSessionIdle = "SessionIdle"

// advanceSessionIdle turns startup/resume/clear into an idle boundary, but only
// after an observer has seen the epoch's unknown bootstrap: the server accepts an
// idle proof only on top of a stored epoch, and the observer pins the first
// sequence it sees to unknown. So SessionStart arms (1), the observer's first poll
// sees it (2), and its next poll applies idle; other readers (the receiver's
// readiness probe) neither advance nor consume it. compact can fire inside a running turn and
// never arms, a SessionStart after a turn was observed never arms, and any later
// lifecycle event disarms. Caller holds nativeMu.
func (b *Broker) advanceSessionIdle(h ActivityHook, proof ClaudeTurnProof, instance string, binding int, quiet bool) ClaudeTurnProof {
	switch {
	case h.Event == "SessionStart":
		// Two parallel SessionStart hooks report the same start; keep the first arming.
		armed := b.sessionIdle
		b.sessionIdle = 0
		switch h.Source {
		case "startup", "resume", "clear":
			if quiet {
				b.sessionIdle = max(armed, 1)
			}
		}
	case h.Event != "":
		b.sessionIdle = 0
	case !h.Observer:
	case b.sessionIdle == 1:
		b.sessionIdle = 2
	case b.sessionIdle == 2:
		if proof.State == "unknown" {
			proof = b.updateClaudeTurnProof(h.NativeID, instance, binding, turnSessionIdle)
		}
		if proof.State != "unknown" {
			b.sessionIdle = 0
		}
	}
	return proof
}

func (b *Broker) nativeTurnIdentity() (string, int) {
	b.session.mu.Lock()
	feed := b.session.nativeState
	b.session.mu.Unlock()
	if feed == nil {
		return "", 0
	}
	var view sessionState
	_, _, live := feed.Snapshot(&view)
	if !live || view.NativeControl == nil {
		return "", 0
	}
	var session struct {
		Binding int `json:"binding_generation"`
	}
	if json.Unmarshal(view.Session, &session) != nil {
		return "", 0
	}
	return view.NativeControl.InstanceID, session.Binding
}

// Caller holds nativeMu, also used by synchronous native lifecycle hooks.
func (b *Broker) updateClaudeTurnProof(native, instance string, binding int, event string) ClaudeTurnProof {
	// A native state feed outage reports an empty identity. That is not a new
	// native instance: keep the epoch so a reconnect does not discard the last
	// observed boundary. Only a different non-empty identity starts a new epoch.
	if b.turnProof.Epoch == "" || b.turnProofNativeID != b.nativeID ||
		(instance != "" && b.turnProof.NativeInstanceID != instance) ||
		(binding > 0 && b.turnProof.BindingGeneration != binding) {
		b.turnProof = ClaudeTurnProof{Epoch: newUUID(), Sequence: 1, State: "unknown", NativeInstanceID: instance, BindingGeneration: binding}
		b.turnProofNativeID = b.nativeID
	}
	if instance == "" || binding <= 0 || b.nativeID == "" || (native != "" && native != b.nativeID) {
		out := b.turnProof
		out.State = "unknown"
		return out
	}
	if event != "" {
		b.turnProof.Sequence++
		switch event {
		case "Stop":
			b.turnProof.State = "idle"
		case turnSessionIdle:
			// Never downgrade a turn already observed as active.
			if b.turnProof.State == "unknown" {
				b.turnProof.State = "idle"
			}
		case "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Elicitation", "ElicitationResult":
			b.turnProof.State = "active"
		default:
			b.turnProof.State = "unknown"
		}
	}
	return b.turnProof
}
func (b *Broker) channelDeliver(w http.ResponseWriter, request *http.Request, raw []byte) {
	var input struct {
		NativeID  string `json:"native_session_id"`
		MessageID string `json:"message_id"`
		Content   string `json:"content"`
		Timing    string `json:"delivery_timing"`
	}
	if json.Unmarshal(raw, &input) != nil || input.MessageID == "" || input.Content == "" ||
		(input.Timing != "immediate" && input.Timing != "after_turn") {
		writeBrokerError(w, 400, "native_delivery_invalid", "Invalid native delivery")
		return
	}
	b.nativeMu.Lock()
	defer b.nativeMu.Unlock()
	instance, binding := b.nativeTurnIdentity()
	proof := b.updateClaudeTurnProof(input.NativeID, instance, binding, "")
	// Claude Code queues channel notifications and presents them in order, so
	// only fresh positive evidence of a running turn defers an after_turn write.
	// Unknown proof (reconnect, observer restart, missed Stop) fails open:
	// requiring a Stop that an idle prompt never produces left sessions deaf.
	evidenceAge := ClaudeActiveStaleAfter
	if !b.hookActivityAt.IsZero() && b.hookActivityNativeID == b.nativeID {
		evidenceAge = time.Since(b.hookActivityAt)
	}
	if b.session.Engine != "claude" || input.NativeID != b.nativeID ||
		(input.Timing == "after_turn" && ClaudeTurnBusy(&proof, evidenceAge)) {
		writeBrokerError(w, 409, "native_boundary_changed", "Native turn boundary changed before submission")
		return
	}
	// Single-shot callback under the same mutex as UserPromptSubmit/Stop. Never
	// retry a failed transport: it may already have written the channel event.
	body, _ := json.Marshal(map[string]any{"session_id": b.session.ID, "message_id": input.MessageID, "content": input.Content, "native_session_id": input.NativeID, "write_deadline_ms": time.Now().Add(250 * time.Millisecond).UnixMilli()})
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(b.dir, "receiver-owner.sock"))
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	ctx, cancel := context.WithTimeout(request.Context(), 3*time.Second)
	defer cancel()
	callback, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://receiver-owner/turn/deliver", bytes.NewReader(body))
	if err != nil {
		writeBrokerError(w, 502, "native_submission_uncertain", "Native submission outcome is unknown")
		return
	}
	callback.Header.Set("Content-Type", "application/json")
	response, err := client.Do(callback)
	if err != nil {
		writeBrokerError(w, 502, "native_submission_uncertain", "Native submission outcome is unknown")
		return
	}
	defer response.Body.Close()
	var receipt struct {
		Delivered bool   `json:"delivered"`
		MessageID string `json:"message_id"`
		Error     struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	encoded, readErr := io.ReadAll(io.LimitReader(response.Body, 4097))
	valid := readErr == nil && len(encoded) <= 4096 && json.Unmarshal(encoded, &receipt) == nil && receipt.MessageID == input.MessageID
	// Only this exact correlated owner receipt proves no write was attempted.
	// A generic rejection or any transport failure remains unknown, never replay.
	if valid && response.StatusCode == http.StatusConflict && receipt.Error.Code == "native_boundary_changed" {
		writeBrokerError(w, 409, "native_boundary_changed", "Native turn boundary changed before submission")
		return
	}
	if !valid || response.StatusCode != http.StatusOK || !receipt.Delivered {
		writeBrokerError(w, 502, "native_submission_uncertain", "Native submission outcome is unknown")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"delivered": true, "message_id": input.MessageID, "turn_proof": proof})
}

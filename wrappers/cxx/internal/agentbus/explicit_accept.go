package agentbus

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var acceptUUID = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

// agentAccept exposes work in this tool response, never through the native
// adapter. Retain both the claim identity and unconfirmed acceptance so a lost
// receipt cannot become a fresh claim or a background native submission.
func agentAccept(ctx context.Context, client *sessionClient, state *channelTracker, args map[string]any) (map[string]any, error) {
	id, claim := strings.ToLower(stringArg(args, "message_id")), strings.ToLower(stringArg(args, "claim_id"))
	if !acceptUUID.MatchString(id) || !acceptUUID.MatchString(claim) {
		return nil, errors.New("message_id and claim_id must be UUIDs; retry with the original pair")
	}
	if state == nil || state.receiver == nil {
		return nil, errors.New("agent_accept requires the ready automatic receiver owner")
	}
	state.acceptMu.Lock()
	defer state.acceptMu.Unlock()
	r := state.receiver
	if r.health()["state"] != "ready" {
		return nil, errors.New("agent_accept receiver_unavailable: automatic receiver is not ready")
	}
	r.mu.Lock()
	generation := r.generation
	r.mu.Unlock()
	if generation == "" {
		return nil, errors.New("agent_accept receiver_unavailable: receiver generation is missing")
	}
	if state.acceptClaims == nil {
		state.acceptClaims = make(map[string]string)
	}
	if original := state.acceptClaims[id]; original != "" && original != claim {
		return nil, errors.New("agent_accept retry must retain the original claim_id")
	}
	pending := state.get(id)
	if pending != nil && (!pending.explicit || pending.claimID != claim) {
		return nil, errors.New("agent_accept cannot replace an existing delivery claim")
	}
	if pending == nil {
		state.acceptClaims[id] = claim
		var out struct {
			Delivery map[string]any `json:"delivery"`
		}
		if err := client.post(ctx, "deliveries/claim", map[string]any{"message_id": id, "claim_id": claim, "receiver_generation": generation, "wait_seconds": 0}, &out); err != nil {
			return nil, err
		}
		if out.Delivery == nil {
			return nil, errors.New("agent_accept target is not currently claimable; retry the same message_id and claim_id")
		}
		kind := stringArg(out.Delivery, "work_kind")
		if stringArg(out.Delivery, "message_id") != id || (kind != "request" && kind != "task") {
			return nil, errors.New("agent_accept refused unexpected delivery identity or work kind; no work exposed")
		}
		pending = state.trackDelivery(ctx, id, claim, true, true, out.Delivery)
	}
	pending.opMu.Lock()
	defer pending.opMu.Unlock()
	if state.get(id) != pending {
		return nil, errors.New("agent_accept original claim is no longer held")
	}
	if err := state.acknowledge(ctx, id, pending, "accepted", ""); err != nil {
		return nil, fmt.Errorf("agent_accept acceptance unconfirmed; retry the original message_id and claim_id: %w", err)
	}
	pending.mu.Lock()
	pending.admission = nil
	delivery := pending.acceptBody
	pending.mu.Unlock()
	return map[string]any{"status": "accepted", "message_id": id, "claim_id": claim, "delivery": delivery}, nil
}

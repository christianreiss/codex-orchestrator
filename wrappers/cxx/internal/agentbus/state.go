package agentbus

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// relayStateLostAfter bounds how long a registration may go without a live
// owner state stream before the worker re-registers from scratch.
const relayStateLostAfter = time.Minute

// relayRegistrationLost reports a claim refusal that no retry of this exact
// registration can cure: its token, generation or instance is no longer valid.
func relayRegistrationLost(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	return apiErr.Status == 401 || apiErr.Status == 403 ||
		apiErr.Code == "agent_messaging_relay_detached" || apiErr.Code == "agent_messaging_lease_lost"
}

// pollState claims only in response to an owner revision or a local capacity
// change. Acceptance and completion retain the existing durable RPC contract.
func (c *relayClient) pollState(ctx context.Context, configs map[string]*config.Config, stderr io.Writer, slots int, state *communicator.StateClient) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer func() {
		if state != nil {
			state.Close()
		}
	}()
	var workers sync.WaitGroup
	defer workers.Wait()
	defer cancel()
	completed := make(chan struct{}, slots)
	active := 0
	lastCapacity := -1
	dirty := true
	revision := ""
	var lostSince time.Time
	for {
		if state == nil {
			if lostSince.IsZero() {
				lostSince = time.Now()
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Second):
			}
			var dialErr error
			state, dialErr = communicator.DialState(ctx, c.baseURL, communicator.StateScope{Topic: "relay", RelayID: c.id, NativeInstanceID: c.instanceID, BindingGeneration: c.generation}, communicator.StateAuth{RelayToken: c.token})
			lastCapacity = -1
			if state == nil {
				// A revoked token, a newer generation or a replaced relay row
				// never accepts this registration again; only re-registering
				// does. Hand control back to the worker loop after a bound.
				if time.Since(lostSince) >= relayStateLostAfter {
					return fmt.Errorf("relay state unavailable for %s: %w", relayStateLostAfter, dialErr)
				}
				continue
			}
		}
		var view struct {
			WorkRevision string `json:"work_revision"`
		}
		frame, changed, live := state.Snapshot(&view)
		if live {
			lostSince = time.Time{}
		}
		if !live {
			state.Close()
			state = nil
			continue
		}
		next := view.WorkRevision
		if next == "" {
			next = frame.Revision
		}
		if revision != next {
			revision = next
			dirty = true
		}
		for dirty && active < slots {
			finish := func() {}
			if c.claimPermit != nil {
				var allowed bool
				finish, allowed = c.claimPermit()
				if !allowed {
					dirty = false
					break
				}
			}
			var claim relayClaim
			if err := c.relayPost(ctx, "/deliveries/claim", map[string]any{"claim_id": newUUID(), "wait_seconds": 0}, &claim); err != nil {
				finish()
				state.Close()
				state = nil
				if relayRegistrationLost(err) {
					return err
				}
				break
			}
			if claim.Delivery == nil {
				finish()
				dirty = false
				break
			}
			active++
			workers.Add(1)
			go func(delivery *relayDelivery, release func()) {
				defer workers.Done()
				defer release()
				if err := c.processDelivery(ctx, configs, delivery); err != nil {
					fmt.Fprintln(stderr, "agent messaging delivery", opaqueID(delivery.MessageID)+":", sanitizedError(err))
				}
				select {
				case completed <- struct{}{}:
				case <-ctx.Done():
				}
			}(claim.Delivery, finish)
		}
		if state == nil {
			continue
		}
		if capacity := slots - active; capacity != lastCapacity {
			if err := state.Update(map[string]any{"capacity": capacity}); err != nil {
				state.Close()
				state = nil
				continue
			}
			lastCapacity = capacity
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-state.Done():
			state.Close()
			state = nil
		case <-changed:
		case <-completed:
			active--
			dirty = true
		}
	}
}

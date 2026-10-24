package agentbus

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

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
	for {
		if state == nil {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Second):
			}
			state, _ = communicator.DialState(ctx, c.baseURL, communicator.StateScope{Topic: "relay", RelayID: c.id, NativeInstanceID: c.instanceID, BindingGeneration: c.generation}, communicator.StateAuth{RelayToken: c.token})
			lastCapacity = -1
			if state == nil {
				continue
			}
		}
		var view struct {
			WorkRevision string `json:"work_revision"`
		}
		frame, changed, live := state.Snapshot(&view)
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

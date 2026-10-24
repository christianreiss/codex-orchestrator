package agentportal

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeprocess"
)

// nativeControlPollEvery bounds how long a portal stop request waits for its
// owned native process. A 3 s poll from every live session was about 1
// request/s fleet-wide (2026-10-23) for requests that almost never exist.
var nativeControlPollEvery = 10 * time.Second

func (s *Session) withNativeControl(ctx context.Context) context.Context {
	runCtx, cancelNative := context.WithCancel(ctx)
	return nativeprocess.WithControl(runCtx, func(stop func() error) func() {
		id := make([]byte, 16)
		if _, err := rand.Read(id); err != nil {
			return func() {}
		}
		id[6] = (id[6] & 15) | 64
		id[8] = (id[8] & 63) | 128
		instance := fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
		pollCtx, cancel := context.WithCancel(runCtx)
		var mu sync.Mutex
		var request string
		var accepted bool
		var finished bool
		var bindingGeneration int
		queueReceipt := func(key, result string) {
			if key == "" {
				return
			}
			_, err := communicator.QueueNativeStopReceipt(s.BaseURL, communicator.NativeStopReceipt{SessionID: s.ID, BindingGeneration: bindingGeneration, NativeInstanceID: instance, RequestID: key, Result: result})
			if err != nil {
				fmt.Fprintf(os.Stderr, "Native stop receipt could not be persisted: %v\n", err)
			}
		}
		done := make(chan struct{})
		call := func(ctx context.Context, report any) (string, error) {
			var result struct {
				Request           string `json:"request_id"`
				Instance          string `json:"instance_id"`
				BindingGeneration int    `json:"binding_generation"`
			}
			body := map[string]any{"protocol": 1, "instance_id": instance}
			if report != nil {
				body["report"] = report
			}
			err := s.bridgeJSON(ctx, http.MethodPost, "/host/agent-sessions/"+url.PathEscape(s.ID)+"/native-control", body, &result)
			if err == nil && result.Instance != instance {
				return "", fmt.Errorf("native control instance mismatch")
			}
			if err == nil {
				bindingGeneration = result.BindingGeneration
			}
			return result.Request, err
		}
		go func() {
			defer close(done)
			// Register this exact native process once, then let its authenticated
			// subscription carry requests. No empty poll runs in connection mode.
			var feed *communicator.StateClient
			if communicator.StateRequired(s.BaseURL) || portalStateAvailable(pollCtx, s.BaseURL) {
				for feed == nil && pollCtx.Err() == nil {
					if _, err := call(pollCtx, nil); err == nil {
						feed, _ = dialPortalState(pollCtx, s.BaseURL, communicator.StateScope{Topic: "session", SessionID: s.ID, NativeInstanceID: instance}, communicator.StateAuth{BridgeToken: s.BridgeToken})
					}
					if feed == nil {
						select {
						case <-pollCtx.Done():
							return
						case <-time.After(time.Second):
						}
					}
				}
				if pollCtx.Err() != nil {
					return
				}
			}
			if feed != nil {
				defer func() { s.mu.Lock(); s.nativeState = nil; s.mu.Unlock() }()
				defer func() {
					if feed != nil {
						feed.Close()
					}
				}()
				lastClaims := "\x00"
				for pollCtx.Err() == nil {
					if feed == nil {
						select {
						case <-pollCtx.Done():
							return
						case <-time.After(time.Second):
						}
						feed, _ = dialPortalState(pollCtx, s.BaseURL, communicator.StateScope{Topic: "session", SessionID: s.ID, NativeInstanceID: instance}, communicator.StateAuth{BridgeToken: s.BridgeToken})
						lastClaims = "\x00"
						continue
					}
					s.mu.Lock()
					s.nativeState = feed
					s.mu.Unlock()
					var view sessionState
					_, changed, live := feed.Snapshot(&view)
					if !live {
						feed.Close()
						feed = nil
						continue
					}
					var identity struct {
						BindingGeneration int `json:"binding_generation"`
					}
					if json.Unmarshal(view.Session, &identity) == nil {
						bindingGeneration = identity.BindingGeneration
					}
					claims, claimsChanged := s.activeClaimSnapshot()
					claimSet := strings.Join(claims, ",")
					if claimSet != lastClaims {
						if err := feed.Update(map[string]any{"active_claim_ids": claims}); err != nil {
							feed.Close()
							feed = nil
							continue
						}
						lastClaims = claimSet
					}
					if view.NativeControl != nil && view.NativeControl.InstanceID == instance && view.NativeControl.RequestID != "" {
						mu.Lock()
						if request == "" && !finished {
							request = view.NativeControl.RequestID
							accepted = stop() == nil
							if accepted {
								cancelNative()
							}
						}
						key, ok := request, accepted
						mu.Unlock()
						state := "refused"
						if ok {
							state = "accepted"
						}
						queueReceipt(key, state)
						// Receipt retries repeat the same request, never the stop action.
						if key != "" {
							_ = retryAmbiguous(pollCtx, 4*time.Second, func(ctx context.Context) error {
								_, err := call(ctx, map[string]any{"request_id": key, "status": state})
								return err
							})
						}
					}
					select {
					case <-pollCtx.Done():
						return
					case <-feed.Done():
						feed.Close()
						feed = nil
					case <-changed:
					case <-claimsChanged:
					}
				}
				return
			}
			timer := time.NewTicker(nativeControlPollEvery)
			defer timer.Stop()
			for {
				mu.Lock()
				var report any
				if request != "" {
					state := "refused"
					if accepted {
						state = "accepted"
					}
					report = map[string]any{"request_id": request, "status": state}
				}
				mu.Unlock()
				callCtx, cancelCall := context.WithTimeout(pollCtx, 4*time.Second)
				next, err := call(callCtx, report)
				cancelCall()
				var portalError *PortalError
				if errors.As(err, &portalError) && (portalError.Status == 404 || portalError.Status == 409) {
					return
				}
				if err == nil && next != "" {
					mu.Lock()
					if request == "" && !finished {
						request = next
						accepted = stop() == nil
						if accepted {
							cancelNative()
						}
					}
					mu.Unlock()
				}
				select {
				case <-pollCtx.Done():
					return
				case <-timer.C:
				}
			}
		}()
		return func() {
			mu.Lock()
			finished = true
			mu.Unlock()
			cancel()
			<-done
			mu.Lock()
			key, stopped := request, accepted
			mu.Unlock()
			if key == "" || !stopped {
				return
			}
			queueReceipt(key, "exited")
			// Wait completed before this callback; retry only the receipt, never execution.
			for attempt := 0; attempt < 2; attempt++ {
				reportCtx, cancelReport := context.WithTimeout(context.Background(), 4*time.Second)
				_, err := call(reportCtx, map[string]any{"request_id": key, "status": "exited"})
				cancelReport()
				if err == nil {
					return
				}
			}
		}
	})
}

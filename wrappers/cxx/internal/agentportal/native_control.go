package agentportal

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeprocess"
)

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
		done := make(chan struct{})
		call := func(ctx context.Context, report any) (string, error) {
			var result struct {
				Request  string `json:"request_id"`
				Instance string `json:"instance_id"`
			}
			body := map[string]any{"protocol": 1, "instance_id": instance}
			if report != nil {
				body["report"] = report
			}
			err := s.bridgeJSON(ctx, http.MethodPost, "/host/agent-sessions/"+url.PathEscape(s.ID)+"/native-control", body, &result)
			if err == nil && result.Instance != instance {
				return "", fmt.Errorf("native control instance mismatch")
			}
			return result.Request, err
		}
		go func() {
			defer close(done)
			timer := time.NewTicker(3 * time.Second)
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

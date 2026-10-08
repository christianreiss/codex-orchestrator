package agentportal

import (
	"context"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/schedulewatch"
	"net/http"
	"net/url"
	"time"
)

// Stream freshness is mandatory for a standalone watchdog. Explicit schedules
// keep their independent authenticated polling contract.
func (s *Session) WithScheduleWatch(ctx context.Context) context.Context {
	if s == nil {
		return ctx
	}
	ctx = schedulewatch.WithPolicy(ctx, func(ctx context.Context) (schedulewatch.Policy, error) {
		var policy schedulewatch.Policy
		if !s.signedReceivePlaneEnabled() {
			return policy, nil
		}
		if s.watchdog != nil {
			if p, known := s.watchdog.policy(time.Now()); known {
				if p.TimeoutSeconds <= 0 {
					return p, nil
				}
				var fresh watchdogSnapshot
				err := s.bridgeJSON(ctx, http.MethodPost, "/host/agent-sessions/"+url.PathEscape(s.ID)+"/agent-messaging/watchdog/get", map[string]any{}, &fresh)
				if err != nil {
					return schedulewatch.Policy{}, err
				}
				return schedulewatch.Policy{TimeoutSeconds: fresh.PolicyTimeout, BindingGeneration: fresh.Generation, TerminateRequested: fresh.Stop}, nil
			}
		}
		err := s.bridgeJSON(ctx, http.MethodPost, "/host/agent-sessions/"+url.PathEscape(s.ID)+"/schedule-policy", map[string]any{}, &policy)
		return policy, err
	})
	return schedulewatch.WithReporter(ctx, func(ctx context.Context, progress time.Time, failure string) error {
		if s.watchdog == nil {
			return nil
		}
		s.watchdog.mu.Lock()
		active := s.watchdog.snapshot.Watchdog != nil
		if failure != "" {
			s.watchdog.failure = failure
		}
		s.watchdog.mu.Unlock()
		if !active {
			return nil
		}
		return s.reportWatchdog(ctx, progress, failure)
	})
}

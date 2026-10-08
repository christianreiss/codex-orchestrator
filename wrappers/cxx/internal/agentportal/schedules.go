package agentportal

import (
	"context"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/schedulewatch"
	"net/http"
	"net/url"
)

// WithScheduleWatch carries live server policy into native child supervision.
func (s *Session) WithScheduleWatch(ctx context.Context) context.Context {
	if s == nil {
		return ctx
	}
	return schedulewatch.WithPolicy(ctx, func(ctx context.Context) (schedulewatch.Policy, error) {
		var policy schedulewatch.Policy
		if !s.signedReceivePlaneEnabled() {
			return policy, nil
		}
		err := s.bridgeJSON(ctx, http.MethodPost, "/host/agent-sessions/"+url.PathEscape(s.ID)+"/schedule-policy", map[string]any{}, &policy)
		return policy, err
	})
}

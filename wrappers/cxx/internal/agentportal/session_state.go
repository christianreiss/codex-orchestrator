package agentportal

import (
	"context"
	"errors"
	"net/http"
)

func sessionFinishedError() error {
	return &PortalError{Status: http.StatusConflict, Code: "agent_session_finished", Message: "Agent session has ended"}
}

// Permanent bridge failures must not become an endless heartbeat loop or a
// host-authenticated resurrection. API restarts preserve bridge rows; an
// unknown bridge therefore cannot safely be distinguished from a revoked one.
func isTerminalBridgeError(err error) bool {
	var portalErr *PortalError
	if !errors.As(err, &portalErr) {
		return false
	}
	switch portalErr.Code {
	case "agent_bridge_expired", "agent_messaging_binding_stale", "agent_messaging_address_disabled":
		return false // Explicitly recoverable; signed-policy gates still apply.
	case "agent_bridge_unauthorized", "agent_bridge_host_auth_changed", "agent_bridge_host_inactive",
		"agent_bridge_host_mismatch", "agent_bridge_token_required", "engine_disabled",
		"agent_session_finished", "agent_session_not_found", "agent_portal_disabled", "agent_session_conflict":
		return true
	}
	// An operation-specific 403 (for example, a conference the agent does
	// not own) denies that operation without invalidating its whole session.
	return portalErr.Status == http.StatusUnauthorized || (portalErr.Status == http.StatusForbidden && portalErr.Code == "")
}

func (s *Session) rememberTerminal(err error) {
	if !isTerminalBridgeError(err) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.terminalErr == nil {
		s.terminalErr = err
		if s.cancelRequests != nil {
			s.cancelRequests()
		}
	}
}

func (s *Session) isInactive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closing || s.finished || s.terminalErr != nil
}

// Finishing cancels normal bridge operations, including host registration
// renewal, before the final HTTP call. A failed final report cannot reactivate
// local heartbeat/recovery while the native process has already exited.
func (s *Session) beginBridgeRequest(parent context.Context, finishing bool) (context.Context, context.CancelFunc, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.terminalErr != nil {
		return nil, nil, s.terminalErr
	}
	if !finishing && (s.closing || s.finished) {
		return nil, nil, sessionFinishedError()
	}
	if finishing {
		ctx, cancel := context.WithCancel(parent)
		return ctx, cancel, nil
	}
	if s.requestContext == nil {
		s.requestContext, s.cancelRequests = context.WithCancel(context.Background())
	}
	ctx, cancel := context.WithCancel(parent)
	stopCancel := context.AfterFunc(s.requestContext, cancel)
	return ctx, func() { stopCancel(); cancel() }, nil
}

// Recovery is single-flight, but a request queued behind another network call
// must still honor its own timeout or the supervising lifecycle's shutdown.
func (s *Session) acquireRecovery(ctx context.Context) (func(), error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		s.mu.Lock()
		if s.recoveryDone == nil {
			done := make(chan struct{})
			s.recoveryDone = done
			s.mu.Unlock()
			return func() {
				s.mu.Lock()
				s.recoveryDone = nil
				close(done)
				s.mu.Unlock()
			}, nil
		}
		done := s.recoveryDone
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-done:
		}
	}
}

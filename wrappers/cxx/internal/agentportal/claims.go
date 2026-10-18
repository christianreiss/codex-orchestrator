package agentportal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

// Only explicit claim operations add entries. Ordinary session heartbeats never
// invent claims. Release or an uncertain renewal removes the local operation.
func (s *Session) observeClaim(path string, raw json.RawMessage) {
	if !strings.Contains(path, "/agent-messaging/claims/") {
		return
	}
	var result struct {
		ID    string `json:"id"`
		State string `json:"state"`
	}
	if json.Unmarshal(raw, &result) != nil || result.ID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeClaims == nil {
		s.activeClaims = make(map[string]bool)
	}
	if result.State == "active" && !strings.HasSuffix(path, "/release") {
		s.activeClaims[result.ID] = true
	} else {
		delete(s.activeClaims, result.ID)
	}
}

func (s *Session) renewActiveClaims(ctx context.Context) {
	s.mu.Lock()
	ids := make([]string, 0, len(s.activeClaims))
	for id := range s.activeClaims {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		var result struct {
			State string `json:"state"`
		}
		err := s.bridgeJSON(ctx, http.MethodPost, "/host/agent-sessions/"+url.PathEscape(s.ID)+"/agent-messaging/claims/status", map[string]any{"claim_id": id, "renew": true}, &result)
		if err != nil || result.State != "active" {
			s.mu.Lock()
			delete(s.activeClaims, id)
			s.mu.Unlock()
		}
	}
}

package agentportal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// claimRenewTimeout bounds one claim's renewal. Each claim gets its own budget
// so a slow answer for one never starves its siblings of the 60-second lease.
var claimRenewTimeout = 5 * time.Second

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
	before := s.activeClaims[result.ID]
	if result.State == "active" && !strings.HasSuffix(path, "/release") {
		s.activeClaims[result.ID] = true
	} else {
		delete(s.activeClaims, result.ID)
	}
	if before != s.activeClaims[result.ID] {
		if s.claimsChanged != nil {
			close(s.claimsChanged)
		}
		s.claimsChanged = make(chan struct{})
	}
}

func (s *Session) activeClaimSnapshot() ([]string, <-chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.claimsChanged == nil {
		s.claimsChanged = make(chan struct{})
	}
	ids := make([]string, 0, len(s.activeClaims))
	for id := range s.activeClaims {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, s.claimsChanged
}

func (s *Session) hasActiveClaims() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.activeClaims) > 0
}

// renewActiveClaims renews every tracked claim concurrently. An entry is
// dropped only on a definitive answer: the server reports a non-active state
// or rejects the renewal (claim_not_active, stale generation, not found,
// terminal bridge error). Timeouts, transport failures and 5xx keep the entry
// so the next heartbeat retries while the server lease is still live.
func (s *Session) renewActiveClaims(ctx context.Context) {
	if _, _, _, used := s.stateView(); used {
		return
	}
	s.mu.Lock()
	ids := make([]string, 0, len(s.activeClaims))
	for id := range s.activeClaims {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			claimCtx, cancel := context.WithTimeout(ctx, claimRenewTimeout)
			defer cancel()
			var result struct {
				State string `json:"state"`
			}
			err := s.bridgeJSON(claimCtx, http.MethodPost, "/host/agent-sessions/"+url.PathEscape(s.ID)+"/agent-messaging/claims/status", map[string]any{"claim_id": id, "renew": true}, &result)
			if err != nil && (ctx.Err() != nil || isRetryableAmbiguous(err)) {
				return
			}
			if err != nil || result.State != "active" {
				s.mu.Lock()
				delete(s.activeClaims, id)
				s.mu.Unlock()
			}
		}(id)
	}
	wg.Wait()
}

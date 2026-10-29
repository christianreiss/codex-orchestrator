package agentportal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestClaimsTrackOnlyExplicitOperations(t *testing.T) {
	s := &Session{}
	s.observeClaim("/heartbeat", json.RawMessage(`{"id":"unrelated","state":"active"}`))
	if len(s.activeClaims) != 0 {
		t.Fatal("heartbeat invented an operation")
	}
	s.observeClaim("/agent-messaging/claims/acquire", json.RawMessage(`{"id":"one","state":"waiting"}`))
	if len(s.activeClaims) != 0 {
		t.Fatal("waiting claim was renewed")
	}
	s.observeClaim("/agent-messaging/claims/status", json.RawMessage(`{"id":"one","state":"active"}`))
	if !s.activeClaims["one"] {
		t.Fatal("granted operation missing")
	}
	s.observeClaim("/agent-messaging/claims/release", json.RawMessage(`{"id":"one","state":"uncertain"}`))
	if len(s.activeClaims) != 0 {
		t.Fatal("uncertain operation was renewed")
	}
}

func TestScopeBrokerRoutesStaySessionBound(t *testing.T) {
	b := &Broker{session: &Session{ID: "ours"}}
	for _, operation := range []string{"context/get", "context/update", "rooms/list", "rooms/read", "rooms/send", "claims/acquire", "claims/status", "claims/release"} {
		if !b.allowedPath("/host/agent-sessions/ours/agent-messaging/" + operation) {
			t.Fatal(operation)
		}
		if b.allowedPath("/host/agent-sessions/theirs/agent-messaging/" + operation) {
			t.Fatal("cross-session route allowed")
		}
	}
	if !b.requiresReceivePlanePolicy("/host/agent-sessions/ours/agent-messaging/rooms/read", nil) {
		t.Fatal("history bypasses receive policy")
	}
}

// renewalServer answers claims/status per claim id with the supplied handler.
func renewalServer(t *testing.T, handle func(id string, w http.ResponseWriter)) *Session {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ClaimID string `json:"claim_id"`
			Renew   bool   `json:"renew"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if !body.Renew {
			t.Errorf("renewal without renew flag")
		}
		handle(body.ClaimID, w)
	}))
	t.Cleanup(srv.Close)
	return &Session{ID: "ours", BaseURL: srv.URL, localBroker: true, http: srv.Client()}
}

func writeClaim(w http.ResponseWriter, id, state string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": id, "state": state}})
}

// One transient failure used to end renewal of that claim for good, so the
// server lease lapsed 60 seconds later while sibling claims stayed active.
func TestClaimRenewalKeepsEntryOnTransientFailure(t *testing.T) {
	var calls atomic.Int32
	s := renewalServer(t, func(id string, w http.ResponseWriter) {
		switch id {
		case "flaky":
			if calls.Add(1) == 1 {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			writeClaim(w, id, "active")
		case "gone":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":{"code":"claim_not_active","message":"Only a live claim can be renewed"}}`))
		case "lapsed":
			writeClaim(w, id, "uncertain")
		}
	})
	s.activeClaims = map[string]bool{"flaky": true, "gone": true, "lapsed": true}
	s.renewActiveClaims(context.Background())
	if !s.activeClaims["flaky"] {
		t.Fatal("transient 503 stopped renewal of a live claim")
	}
	if s.activeClaims["gone"] || s.activeClaims["lapsed"] {
		t.Fatalf("definitive non-active answers kept: %v", s.activeClaims)
	}
	s.renewActiveClaims(context.Background())
	if !s.activeClaims["flaky"] || calls.Load() != 2 {
		t.Fatalf("retry did not renew flaky claim: calls=%d", calls.Load())
	}
}

// A failing heartbeat used to skip renewal and back off to four intervals,
// which outlives the 60-second lease after two consecutive failures.
func TestClaimRenewalContinuesThroughFailedHeartbeats(t *testing.T) {
	var renewals atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/claims/status") {
			renewals.Add(1)
			writeClaim(w, "held", "active")
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	s := &Session{ID: "ours", BaseURL: srv.URL, localBroker: true, http: srv.Client(), activeClaims: map[string]bool{"held": true}}
	stop := s.startHeartbeat(context.Background(), 20*time.Millisecond)
	time.Sleep(250 * time.Millisecond)
	stop()
	// Uncapped backoff (20, 40, 80, 80 ms) would allow at most four ticks.
	if got := renewals.Load(); got < 7 {
		t.Fatalf("renewals=%d through failing heartbeats, want one per interval", got)
	}
}

// Renewals used to share the heartbeat's single 6-second budget, so one slow
// answer could time out (and drop) whichever claims came after it.
func TestSlowClaimRenewalDoesNotStarveSiblings(t *testing.T) {
	old := claimRenewTimeout
	claimRenewTimeout = 50 * time.Millisecond
	t.Cleanup(func() { claimRenewTimeout = old })
	var renewed sync.Map
	release := make(chan struct{})
	s := renewalServer(t, func(id string, w http.ResponseWriter) {
		if id == "slow" {
			select {
			case <-release:
			case <-time.After(time.Second):
			}
			return
		}
		renewed.Store(id, true)
		writeClaim(w, id, "active")
	})
	t.Cleanup(func() { close(release) })
	s.activeClaims = map[string]bool{"slow": true, "a": true, "b": true, "c": true}
	begin := time.Now()
	s.renewActiveClaims(context.Background())
	if time.Since(begin) > 500*time.Millisecond {
		t.Fatal("renewal exceeded per-claim budget")
	}
	for _, id := range []string{"a", "b", "c"} {
		if _, ok := renewed.Load(id); !ok {
			t.Fatalf("sibling %s was not renewed", id)
		}
	}
	if len(s.activeClaims) != 4 {
		t.Fatalf("timed-out renewal dropped a live claim: %v", s.activeClaims)
	}
}

// Claim clients may retry only this rejection because it is guaranteed to occur
// before upstream dispatch. Keep that guarantee true for every engine/operation.
func TestClaimAttachmentRejectionNeverDispatches(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			var upstream atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { upstream.Add(1) }))
			defer remote.Close()
			b := &Broker{ctx: context.Background(), requests: make(map[uint64]context.CancelFunc), session: &Session{ID: "ours", Engine: engine, BridgeToken: "fixture", BaseURL: remote.URL, http: remote.Client(), stateUsed: true}}
			for _, operation := range []string{"acquire", "status", "release"} {
				w := httptest.NewRecorder()
				b.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/host/agent-sessions/ours/agent-messaging/claims/"+operation, strings.NewReader(`{}`)))
				if w.Code != 503 || !strings.Contains(w.Body.String(), `"native_attachment_unavailable"`) {
					t.Fatalf("unexpected rejection: %d %s", w.Code, w.Body.String())
				}
			}
			if upstream.Load() != 0 {
				t.Fatalf("rejected claims reached upstream: %d", upstream.Load())
			}
		})
	}
}

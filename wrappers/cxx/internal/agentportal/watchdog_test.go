package agentportal

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func frame(t *testing.T, now time.Time, deadline time.Time) watchdogSnapshot {
	t.Helper()
	var s watchdogSnapshot
	raw := fmt.Sprintf(`{"server_time":%q,"binding_generation":3,"progress_timeout_seconds":600,"watchdog":{"id":"task","deadline_at":%q,"native_session_id":"native","status":"watching"}}`, now.Format(time.RFC3339Nano), deadline.Format(time.RFC3339Nano))
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		t.Fatal(err)
	}
	return s
}
func TestWatchdogFreshnessDeadlineAndClockSkew(t *testing.T) {
	local := time.Now()
	server := local.Add(3 * time.Hour)
	f := &watchdogFeed{snapshot: frame(t, server, server.Add(time.Minute)), received: local}
	p, known := f.policy(local.Add(44 * time.Second))
	if !known || p.TimeoutSeconds != 600 || p.BindingGeneration != 3 {
		t.Fatal(p, known)
	}
	p, known = f.policy(local.Add(45 * time.Second))
	if !known || p.TimeoutSeconds != 0 {
		t.Fatal("three missing frames must revoke termination", p)
	}
	f.received = local.Add(30 * time.Second)
	f.snapshot.ServerTime = server.Add(30 * time.Second)
	p, _ = f.policy(local.Add(time.Minute))
	if p.TimeoutSeconds != 0 {
		t.Fatal("server deadline must fence clock skew")
	}
	f.snapshot.Watchdog = nil
	if _, known = f.policy(local); known {
		t.Fatal("explicit schedules must retain their independent policy")
	}
}
func TestWatchdogFeedWorksWithoutModelAndIgnoresDelayedFrames(t *testing.T) {
	now := time.Now().UTC()
	fresh := frame(t, now, now.Add(time.Hour))
	stale := fresh
	stale.ServerTime = now.Add(-time.Second)
	stale.PolicyTimeout = 1
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-agent-bridge-token") != "bridge" {
			t.Error("missing bridge authentication")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		for _, s := range []watchdogSnapshot{fresh, stale} {
			raw, _ := json.Marshal(s)
			fmt.Fprintf(w, "event: watchdog\ndata: %s\n\n", raw)
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	s := &Session{ID: "session", BridgeToken: "bridge", BaseURL: server.URL, http: server.Client(), watchdog: &watchdogFeed{}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.consumeWatchdogFeed(ctx) }()
	until := time.Now().Add(time.Second)
	for time.Now().Before(until) {
		s.watchdog.mu.Lock()
		received := s.watchdog.received
		timeout := s.watchdog.snapshot.PolicyTimeout
		s.watchdog.mu.Unlock()
		if !received.IsZero() {
			if timeout != 600 {
				t.Fatal("stale policy accepted")
			}
			cancel()
			<-done
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("independent feed did not deliver")
}

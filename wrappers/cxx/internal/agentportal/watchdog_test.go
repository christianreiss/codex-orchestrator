package agentportal

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestFinishRetriesTheSameWatchdogCauseAfterLostResponse(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			var requests []map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/host/agent-sessions/session/finish" {
					t.Errorf("unexpected standalone request: %s", r.URL.Path)
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				requests = append(requests, body)
				if len(requests) == 1 {
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					_ = conn.Close() // terminal write committed; its response is lost
					return
				}
				_, _ = w.Write([]byte(`{}`))
			}))
			defer server.Close()
			s := &Session{ID: "session", Engine: engine, BridgeToken: "bridge", BaseURL: server.URL, http: server.Client(), watchdog: &watchdogFeed{}}
			if err := s.Finish("completed", "done"); err != nil {
				t.Fatal(err)
			}
			if err := s.Finish("completed", "done"); err != nil {
				t.Fatal(err)
			}
			if len(requests) != 2 || !reflect.DeepEqual(requests[0], requests[1]) || requests[0]["watchdog_failure"] != "user_stop" {
				t.Fatalf("terminal retries lost or changed exit cause: %#v", requests)
			}
		})
	}
}

func TestWatchdogTerminalClassification(t *testing.T) {
	for _, tc := range []struct {
		name, status, summary, observed, want string
		worker                                bool
	}{
		{name: "clean", status: "completed", want: "user_stop"},
		{name: "crash", status: "failed", want: "crash"},
		{name: "interrupt", status: "failed", summary: "exit status 130", want: "user_stop"},
		{name: "capacity", status: "failed", observed: "capacity", want: "capacity"},
		{name: "hang", status: "failed", observed: "hang", want: "hang"},
		{name: "blocked", status: "failed", observed: "blocked", want: "blocked"},
		{name: "worker", status: "completed", worker: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &Session{watchdog: &watchdogFeed{failure: tc.observed}, peerDelivery: tc.worker}
			if got := s.watchdogExitFailure(tc.status, tc.summary); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

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

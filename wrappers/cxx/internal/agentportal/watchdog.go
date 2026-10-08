package agentportal

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/schedulewatch"
)

type watchdogSnapshot struct {
	ServerTime    time.Time `json:"server_time"`
	PolicyTimeout int       `json:"progress_timeout_seconds"`
	Generation    int       `json:"binding_generation"`
	Stop          bool      `json:"terminate_requested"`
	Watchdog      *struct {
		ID       string    `json:"id"`
		Deadline time.Time `json:"deadline_at"`
		NativeID string    `json:"native_session_id"`
		Status   string    `json:"status"`
	} `json:"watchdog"`
}
type watchdogFeed struct {
	mu       sync.Mutex
	snapshot watchdogSnapshot
	received time.Time
	failure  string
}

func (f *watchdogFeed) policy(now time.Time) (schedulewatch.Policy, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.snapshot
	if s.Watchdog == nil {
		return schedulewatch.Policy{}, false
	}
	if f.received.IsZero() || now.Sub(f.received) >= 45*time.Second || !s.Watchdog.Deadline.After(s.ServerTime.Add(now.Sub(f.received))) {
		return schedulewatch.Policy{}, true
	}
	return schedulewatch.Policy{TimeoutSeconds: s.PolicyTimeout, BindingGeneration: s.Generation, TerminateRequested: s.Stop}, true
}
func (s *Session) startWatchdogFeed(ctx context.Context) func() {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		backoff := time.Second
		disconnected := false
		for ctx.Err() == nil {
			if s.signedReceivePlaneEnabled() {
				_ = s.consumeWatchdogFeed(ctx)
				s.watchdog.mu.Lock()
				active := s.watchdog.snapshot.Watchdog != nil
				stale := time.Since(s.watchdog.received) >= 45*time.Second
				s.watchdog.mu.Unlock()
				if active && stale && !disconnected {
					fmt.Fprintln(os.Stderr, "cxx watchdog: keep-alive disconnected; local termination suspended, reconnecting")
					disconnected = true
				}
				if !stale {
					disconnected = false
					backoff = time.Second
				}
			}
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}()
	return func() { cancel(); <-done }
}
func (s *Session) consumeWatchdogFeed(ctx context.Context) error {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(streamCtx, http.MethodGet, strings.TrimRight(s.BaseURL, "/")+"/host/agent-sessions/"+url.PathEscape(s.ID)+"/watchdog/stream", nil)
	if err != nil {
		return err
	}
	req.Header.Set("x-agent-bridge-token", s.BridgeToken)
	req.Header.Set("Accept", "text/event-stream")
	client := *s.http
	client.Timeout = 0
	// A silent connection is canceled independently of the model, then reconnected.
	silence := time.AfterFunc(45*time.Second, cancel)
	defer silence.Stop()
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return errors.New("watchdog stream unavailable")
	}
	scan := bufio.NewScanner(resp.Body)
	scan.Buffer(make([]byte, 4096), 65536)
	for scan.Scan() {
		line := scan.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var frame watchdogSnapshot
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &frame) != nil || frame.ServerTime.IsZero() {
			continue
		}
		s.watchdog.mu.Lock()
		// A delayed frame must not roll back policy or renew the freshness clock.
		if s.watchdog.snapshot.ServerTime.IsZero() || frame.ServerTime.After(s.watchdog.snapshot.ServerTime) {
			s.watchdog.snapshot = frame
			s.watchdog.received = time.Now()
			silence.Reset(45 * time.Second)
		}
		s.watchdog.mu.Unlock()
	}
	return scan.Err()
}
func (s *Session) reportWatchdog(ctx context.Context, progress time.Time, failure string) error {
	body := map[string]any{"last_progress_at": progress.UTC().Format(time.RFC3339Nano)}
	if failure != "" {
		body["failure"] = failure
	}
	var ignored map[string]any
	return s.bridgeJSON(ctx, http.MethodPost, "/host/agent-sessions/"+url.PathEscape(s.ID)+"/watchdog/activity", body, &ignored)
}
func (s *Session) watchdogExit(status, summary string) {
	if os.Getenv("CXX_AGENT_MESSAGING_MESSAGE_ID") != "" {
		return
	} // Worker stores its durable outcome and retry hint.
	if s == nil || s.watchdog == nil || !s.signedReceivePlaneEnabled() {
		return
	}
	s.watchdog.mu.Lock()
	f := s.watchdog.failure
	s.watchdog.mu.Unlock()
	if f == "" {
		if status == "failed" {
			f = "crash"
		} else {
			f = "user_stop"
		}
	}
	text := strings.ToLower(summary)
	if strings.Contains(text, "130") || strings.Contains(text, "interrupt") || strings.Contains(text, "context canceled") {
		f = "user_stop"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	_ = s.reportWatchdog(ctx, time.Now(), f)
}

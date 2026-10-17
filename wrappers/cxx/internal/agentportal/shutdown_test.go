package agentportal

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCloseUsesOnlyFinishAndRecognizesNestedEndedConflict(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		for _, code := range []string{"agent_session_finished", "agent_identity_conflict"} {
			t.Run(engine+"/"+code, func(t *testing.T) {
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					if !strings.HasSuffix(r.URL.Path, "/finish") {
						t.Errorf("redundant shutdown call: %s", r.URL.Path)
					}
					w.WriteHeader(409)
					json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": "already ended or conflicting"}})
				}))
				defer server.Close()
				session := &Session{ID: "session", Engine: engine, BridgeToken: "bridge", BaseURL: server.URL, http: server.Client()}
				runtime := &ConnectionRuntime{session: session, stopHeartbeat: func() {}, restore: func() {}}
				err := runtime.Close("completed", "done")
				if (err == nil) != (code == "agent_session_finished") {
					t.Fatalf("close error: %v", err)
				}
				runtime.Close("completed", "done")
				if calls.Load() != 1 {
					t.Fatalf("requests=%d", calls.Load())
				}
			})
		}
	}
}

func TestFinishContextBoundsAllRetries(t *testing.T) {
	var calls atomic.Int32
	session := &Session{ID: "session", BridgeToken: "bridge", BaseURL: "http://portal.invalid", http: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	started := time.Now()
	if err := session.FinishContext(ctx, "completed", "done"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error=%v", err)
	}
	if time.Since(started) > time.Second || calls.Load() != 1 {
		t.Fatalf("budget reset: %v requests=%d", time.Since(started), calls.Load())
	}
}

func TestSessionEndObservationStaysLocalUntilFinish(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if !strings.HasSuffix(r.URL.Path, "/finish") {
			t.Errorf("exit hook waited on upstream: %s", r.URL.Path)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["watchdog_failure"] != "user_stop" {
			t.Errorf("lost cause: %v", body)
		}
		io.WriteString(w, `{}`)
	}))
	defer server.Close()
	session := &Session{ID: "session", Engine: "claude", BridgeToken: "bridge", BaseURL: server.URL, http: server.Client(), watchdog: &watchdogFeed{}}
	broker, err := session.StartBroker(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	broker.nativeID = "native"
	client := newUnixHTTPClient(broker.socketPath, time.Second)
	res, err := client.Post("http://broker/host/agent-sessions/session/watchdog/activity", "application/json", strings.NewReader(`{"failure":"user_stop","native_session_id":"native","session_end":true}`))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 || calls.Load() != 0 {
		t.Fatalf("status=%d upstream=%d", res.StatusCode, calls.Load())
	}
	if err := session.Finish("completed", "done"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("requests=%d", calls.Load())
	}
}

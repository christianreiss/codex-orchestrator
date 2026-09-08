package agentportal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

const recoverySessionID = "11111111-1111-4111-8111-111111111111"

func recoverySession(engine, base string, client *http.Client) *Session {
	return &Session{
		ID: recoverySessionID, BridgeToken: testBridgeToken, BaseURL: base, Engine: engine,
		hostAPIKey: "host-fixture", http: client, registrationGeneration: 1,
		registrationBody: map[string]any{
			"session_id": recoverySessionID, "bridge_token": testBridgeToken, "engine": engine,
		},
	}
}

func writeRenewal(w http.ResponseWriter) {
	_ = json.NewEncoder(w).Encode(map[string]any{
		"enabled": true, "session_id": recoverySessionID, "bridge_token": testBridgeToken,
	})
}

func TestStartupOutageRecoversSameIdentityThroughExistingBroker(t *testing.T) {
	for _, engine := range []string{config.EngineCodex, config.EngineClaude} {
		t.Run(engine, func(t *testing.T) {
			var registrations atomic.Int32
			var available atomic.Bool
			var identity, token string
			var identityMu sync.Mutex
			heartbeat := make(chan struct{}, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/host/agent-sessions":
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					identityMu.Lock()
					if registrations.Add(1) == 1 {
						identity, _ = body["session_id"].(string)
						token, _ = body["bridge_token"].(string)
					} else if body["session_id"] != identity || body["bridge_token"] != token || body["engine"] != engine {
						t.Error("startup retry changed its reserved identity or engine")
					}
					identityMu.Unlock()
					if !available.Load() {
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"enabled": true, "session_id": body["session_id"], "bridge_token": body["bridge_token"]})
				case strings.HasSuffix(r.URL.Path, "/heartbeat"):
					select {
					case heartbeat <- struct{}{}:
					default:
					}
					_, _ = w.Write([]byte(`{}`))
				case strings.HasSuffix(r.URL.Path, "/commands/claim"):
					_, _ = w.Write([]byte(`{"message":null}`))
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
				}
			}))
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			session, err := Start(ctx, &config.Config{Engine: engine, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "host-fixture"}}, StartInput{Engine: engine})
			if err == nil || session == nil || !session.pendingRegistration || registrations.Load() != 2 {
				t.Fatalf("startup outage lost recovery capability: pending=%t registrations=%d err=%v", session != nil, registrations.Load(), err)
			}
			broker, err := session.StartBroker(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer broker.Close()
			available.Store(true)
			stop := session.startHeartbeat(ctx, 10*time.Millisecond)
			defer stop()
			select {
			case <-heartbeat:
			case <-time.After(time.Second):
				t.Fatal("live agent did not register after API recovery")
			}
			local := &Session{ID: session.ID, Engine: engine, BaseURL: "http://agent-portal.local", localBroker: true, http: newUnixHTTPClient(broker.socketPath, time.Second)}
			if _, err := local.Claim(ctx, 0, newUUID()); err != nil {
				t.Fatalf("existing broker did not recover: %v", err)
			}
			if registrations.Load() != 3 {
				t.Fatalf("registration retries=%d, want stable identity admitted once", registrations.Load())
			}
		})
	}
}

func TestStartupPermanentDenialNeverCreatesPendingRegistration(t *testing.T) {
	for _, denial := range []struct {
		code   string
		status int
	}{
		{"agent_bridge_host_auth_changed", http.StatusUnauthorized},
		{"engine_disabled", http.StatusForbidden},
		{"agent_portal_disabled", http.StatusServiceUnavailable},
	} {
		t.Run(denial.code, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.WriteHeader(denial.status)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": denial.code})
			}))
			defer server.Close()
			session, err := Start(context.Background(), &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "host-fixture"}}, StartInput{Engine: config.EngineCodex})
			if session != nil || err == nil || calls.Load() != 1 {
				t.Fatalf("permanent denial retried or became pending: session=%t calls=%d err=%v", session != nil, calls.Load(), err)
			}
		})
	}
}

func TestStoppingHeartbeatCancelsInflightRequest(t *testing.T) {
	started, canceled := make(chan struct{}), make(chan struct{})
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		close(started)
		<-r.Context().Done()
		close(canceled)
		return nil, r.Context().Err()
	})}
	session := recoverySession(config.EngineClaude, "http://portal.invalid", client)
	stop := session.startHeartbeat(context.Background(), time.Millisecond)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("heartbeat did not start")
	}
	begin := time.Now()
	stop()
	if time.Since(begin) > 300*time.Millisecond {
		t.Fatal("heartbeat stop left a background request running")
	}
	select {
	case <-canceled:
	default:
		t.Fatal("inflight heartbeat was not canceled")
	}
}

func TestTerminalBridgeFailuresStopHeartbeatWithoutReregistering(t *testing.T) {
	for _, engine := range []string{config.EngineCodex, config.EngineClaude} {
		for _, denial := range []struct {
			code   string
			status int
		}{
			{"agent_bridge_unauthorized", 401}, {"agent_bridge_host_auth_changed", 401},
			{"agent_bridge_host_inactive", 403}, {"agent_bridge_host_mismatch", 403},
			{"engine_disabled", 403}, {"agent_session_finished", 409},
			{"agent_session_not_found", 404}, {"agent_portal_disabled", 503},
		} {
			t.Run(engine+"/"+denial.code, func(t *testing.T) {
				var calls atomic.Int32
				observed := make(chan struct{}, 1)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					if r.URL.Path == "/host/agent-sessions" {
						t.Error("terminal bridge attempted host registration")
					}
					w.WriteHeader(denial.status)
					_ = json.NewEncoder(w).Encode(map[string]any{"code": denial.code})
					select {
					case observed <- struct{}{}:
					default:
					}
				}))
				defer server.Close()
				session := recoverySession(engine, server.URL, server.Client())
				stop := session.startHeartbeat(context.Background(), 3*time.Millisecond)
				defer stop()
				select {
				case <-observed:
				case <-time.After(time.Second):
					t.Fatal("heartbeat did not reach server")
				}
				time.Sleep(25 * time.Millisecond)
				if err := session.Heartbeat(context.Background(), "", ""); !portalErrorCode(err, denial.code) {
					t.Fatalf("terminal reason lost: %v", err)
				}
				if calls.Load() != 1 {
					t.Fatalf("terminal bridge kept issuing requests: %d", calls.Load())
				}
			})
		}
	}
}

func TestExpiredBridgeConcurrentRequestsShareOneRenewal(t *testing.T) {
	for _, engine := range []string{config.EngineCodex, config.EngineClaude} {
		t.Run(engine, func(t *testing.T) {
			var registrations atomic.Int32
			var renewed atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/host/agent-sessions" {
					registrations.Add(1)
					renewed.Store(true)
					writeRenewal(w)
					return
				}
				if !renewed.Load() {
					w.WriteHeader(401)
					_, _ = w.Write([]byte(`{"code":"agent_bridge_expired"}`))
					return
				}
				_, _ = w.Write([]byte(`{}`))
			}))
			defer server.Close()
			session := recoverySession(engine, server.URL, server.Client())
			var workers sync.WaitGroup
			for range 12 {
				workers.Add(1)
				go func() {
					defer workers.Done()
					if err := session.Heartbeat(context.Background(), "", ""); err != nil {
						t.Errorf("heartbeat: %v", err)
					}
				}()
			}
			workers.Wait()
			if registrations.Load() != 1 {
				t.Fatalf("concurrent renewal registered %d times", registrations.Load())
			}
		})
	}
}

func TestWaitingForBridgeRecoveryHonorsCallerCancellation(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/host/agent-sessions" {
			close(started)
			<-release
			writeRenewal(w)
			return
		}
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"code":"agent_bridge_expired"}`))
	}))
	defer server.Close()
	session := recoverySession(config.EngineCodex, server.URL, server.Client())
	first := make(chan error, 1)
	go func() { first <- session.Heartbeat(context.Background(), "", "") }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("renewal did not start")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	second := make(chan error, 1)
	go func() { second <- session.Heartbeat(ctx, "", "") }()
	select {
	case err := <-second:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("queued recovery error=%v", err)
		}
	case <-time.After(300 * time.Millisecond):
		close(release)
		<-first
		t.Fatal("expired caller remained queued behind recovery mutex")
	}
	close(release)
	<-first
}

func responseFor(r *http.Request, status int, raw string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(raw)), Request: r}
}

func TestFinishPreventsLateRecoveryFromPublishingOrSendingAnotherHeartbeat(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var heartbeats, finishes atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch {
		case r.URL.Path == "/host/agent-sessions":
			close(started)
			<-release // Simulate a late response after cancellation.
			return responseFor(r, 200, fmt.Sprintf(`{"enabled":true,"session_id":%q,"bridge_token":%q}`, recoverySessionID, testBridgeToken)), nil
		case strings.HasSuffix(r.URL.Path, "/finish"):
			finishes.Add(1)
			return responseFor(r, 200, `{}`), nil
		default:
			heartbeats.Add(1)
			return responseFor(r, 401, `{"code":"agent_bridge_expired"}`), nil
		}
	})}
	session := recoverySession(config.EngineClaude, "http://portal.invalid", client)
	renew := make(chan error, 1)
	go func() { renew <- session.Heartbeat(context.Background(), "", "") }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("renewal did not start")
	}
	if err := session.Finish("completed", "done"); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	if err := <-renew; err == nil {
		t.Fatal("late recovery succeeded after local finish")
	}
	if err := session.Heartbeat(context.Background(), "", ""); !portalErrorCode(err, "agent_session_finished") {
		t.Fatalf("post-finish heartbeat=%v", err)
	}
	if session.registrationGeneration != 1 || heartbeats.Load() != 1 || finishes.Load() != 1 {
		t.Fatalf("late recovery changed state: generation=%d beats=%d finishes=%d", session.registrationGeneration, heartbeats.Load(), finishes.Load())
	}
}

func TestFinishRetries503ButNeverReactivatesAfterFailure(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); w.WriteHeader(503) }))
	defer server.Close()
	session := recoverySession(config.EngineCodex, server.URL, server.Client())
	if err := session.Finish("completed", "done"); err == nil {
		t.Fatal("failed finalization reported success")
	}
	if err := session.Heartbeat(context.Background(), "", ""); !portalErrorCode(err, "agent_session_finished") {
		t.Fatalf("failed finish allowed heartbeat: %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("finalization attempts=%d", calls.Load())
	}
}

func TestOperationPermissionDeniedDoesNotInvalidateLiveBridge(t *testing.T) {
	var heartbeats atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/heartbeat") {
			heartbeats.Add(1)
			_, _ = w.Write([]byte(`{}`))
			return
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"code":"agent_messaging_conference_not_owner"}`))
	}))
	defer server.Close()
	session := recoverySession(config.EngineCodex, server.URL, server.Client())
	if err := session.bridgeJSON(context.Background(), http.MethodPost, "/host/agent-sessions/"+recoverySessionID+"/agent-messaging/conf/dispatch", map[string]any{}, nil); !portalErrorCode(err, "agent_messaging_conference_not_owner") {
		t.Fatalf("operation denial=%v", err)
	}
	if err := session.Heartbeat(context.Background(), "", ""); err != nil || heartbeats.Load() != 1 {
		t.Fatalf("operation denial disabled a valid bridge: heartbeats=%d err=%v", heartbeats.Load(), err)
	}
}

func TestFinishingPendingStartupNeverRegistersANewSession(t *testing.T) {
	var registrations atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/host/agent-sessions" {
			registrations.Add(1)
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"code":"agent_bridge_unauthorized"}`))
	}))
	defer server.Close()
	session, err := Start(context.Background(), &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "host-fixture"}}, StartInput{Engine: config.EngineCodex})
	if err == nil || session == nil {
		t.Fatal("expected pending startup")
	}
	// Both persona lifecycles close the relay before closing the broker and
	// sending Finish. That preparatory heartbeat must not create a ghost row.
	if err := session.Heartbeat(context.Background(), "", "close"); err != nil {
		t.Fatalf("pending relay close: %v", err)
	}
	if err := session.Finish("completed", "done"); !portalErrorCode(err, "agent_bridge_unauthorized") {
		t.Fatalf("finish error=%v", err)
	}
	if registrations.Load() != 2 {
		t.Fatal("finalization created a ghost registration after native exit")
	}
}

func TestBrokerForwardingHasBoundedResponseBodyLifetime(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) > 35*time.Second || time.Until(deadline) < 30*time.Second {
			t.Errorf("broker forwarding lacks long-poll-safe deadline: %v", deadline)
		}
		return responseFor(r, 200, `{}`), nil
	})}
	broker := testDirectBroker(recoverySession(config.EngineCodex, "http://portal.invalid", client))
	response := serveBrokerRequest(broker, "/host/agent-sessions/"+recoverySessionID+"/commands/claim", `{"wait_seconds":25}`)
	if response.Code != 200 {
		t.Fatalf("broker result=%d", response.Code)
	}
}

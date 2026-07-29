package agentportal

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

const testBridgeToken = "bridge-123456789012345678901234567890123456"

func TestSessionFromEnvironmentRequiresPrivateSocket(t *testing.T) {
	for _, key := range []string{envSocket, envBaseURL, envSessionID, envBridgeToken, envCABundle, envAllowInsecure, envEngine} {
		t.Setenv(key, "")
	}
	if _, err := SessionFromEnvironment(time.Second); err == nil || !strings.Contains(err.Error(), "managed session") {
		t.Fatalf("expected managed-session error, got %v", err)
	}
}

func TestStartRetriesRegistrationAndExposesNoPortalBridgeCredential(t *testing.T) {
	const hostSecret = "host-api-key-that-must-not-reach-the-child"
	var attempts int
	var sessionID string
	var bridgeToken string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if r.Method != http.MethodPost || r.URL.Path != "/host/agent-sessions" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("X-API-Key"); got != hostSecret {
			t.Errorf("registration host key = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode registration: %v", err)
			return
		}
		gotSession, _ := body["session_id"].(string)
		gotToken, _ := body["bridge_token"].(string)
		if attempts == 1 {
			sessionID, bridgeToken = gotSession, gotToken
			hijacker := w.(http.Hijacker)
			conn, _, err := hijacker.Hijack()
			if err != nil {
				t.Fatalf("hijack: %v", err)
			}
			_ = conn.Close()
			return
		}
		if gotSession != sessionID || gotToken != bridgeToken {
			t.Errorf("registration retry changed credentials")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"enabled": true, "session_id": gotSession, "bridge_token": gotToken,
			"expires_at": "2026-07-29T12:00:00Z",
		})
	}))
	defer server.Close()

	session, err := Start(context.Background(), &config.Config{
		Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: hostSecret},
	}, StartInput{Engine: config.EngineCodex, InvocationKind: "interactive"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if session == nil || attempts != 2 {
		t.Fatalf("session=%v attempts=%d", session, attempts)
	}
	broker, err := session.StartBroker(context.Background())
	if err != nil {
		t.Fatalf("StartBroker: %v", err)
	}
	restore := broker.ActivateEnvironment()
	defer restore()
	defer broker.Close()
	if os.Getenv(envSocket) == "" || os.Getenv(envSessionID) != sessionID {
		t.Fatalf("socket environment was not activated")
	}
	for _, key := range []string{envBaseURL, envBridgeToken, envCABundle, envAllowInsecure} {
		if value := os.Getenv(key); value != "" {
			t.Fatalf("sensitive child environment %s=%q", key, value)
		}
	}
	for _, entry := range os.Environ() {
		if strings.Contains(entry, hostSecret) || strings.Contains(entry, bridgeToken) || strings.Contains(entry, server.URL) {
			t.Fatalf("network credential leaked into child environment via %q", entry)
		}
	}
	dirInfo, err := os.Stat(broker.dir)
	if err != nil || dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("broker dir mode=%v err=%v", dirInfo.Mode().Perm(), err)
	}
	socketInfo, err := os.Stat(broker.socketPath)
	if err != nil || socketInfo.Mode().Perm() != 0o600 {
		t.Fatalf("broker socket mode=%v err=%v", socketInfo.Mode().Perm(), err)
	}
}

func TestNotifyUsesPrivateBrokerAndServerDerivedSource(t *testing.T) {
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		if got := r.Header.Get("X-Agent-Bridge-Token"); got != testBridgeToken {
			t.Errorf("bridge token = %q", got)
		}
		if got := r.Header.Get("X-API-Key"); got != "" {
			t.Errorf("portal helper leaked host key %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			if body["relay_action"] != "poll" {
				t.Errorf("heartbeat body = %#v", body)
			}
		case strings.HasSuffix(r.URL.Path, "/events"):
			if body["type"] != "attention" || body["source"] != nil {
				t.Errorf("event body = %#v", body)
			}
			payload, _ := body["payload"].(map[string]any)
			if payload["summary"] != "Please check the agent" {
				t.Errorf("payload = %#v", payload)
			}
		default:
			t.Errorf("path = %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": map[string]any{"queued": true}})
	}))
	defer server.Close()
	activatePortalBroker(t, server)

	var stdout, stderr bytes.Buffer
	if code := RunCommand([]string{"notify", "--summary", " Please check the agent "}, &stdout, &stderr); code != 0 {
		t.Fatalf("code=%d stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), `"status":"queued"`) {
		t.Fatalf("stdout=%q", stdout.String())
	}
	if len(calls) != 2 || !strings.HasSuffix(calls[0], "/heartbeat") || !strings.HasSuffix(calls[1], "/events") {
		t.Fatalf("call order = %#v", calls)
	}
}

func TestUpstreamClientAllowsLongPollBeyondSetupTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(30 * time.Millisecond)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	client, err := newHTTPClient(nil, false, 10*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request should be governed by call context, not setup timeout: %v", err)
	}
	_ = resp.Body.Close()
}

func TestScrubEnvironmentRemovesAndRestoresInheritedPortalCapability(t *testing.T) {
	keys := []string{envSocket, envSessionID, envEngine, envBaseURL, envBridgeToken, envCABundle, envAllowInsecure}
	for _, key := range keys {
		t.Setenv(key, "outer-value")
	}
	restore := ScrubEnvironment()
	for _, key := range keys {
		if value, ok := os.LookupEnv(key); ok || value != "" {
			t.Fatalf("%s survived scrub as %q", key, value)
		}
	}
	restore()
	for _, key := range keys {
		if value := os.Getenv(key); value != "outer-value" {
			t.Fatalf("%s was not restored: %q", key, value)
		}
	}
}

func TestWaitRequiresExplicitModelAcceptance(t *testing.T) {
	claimCalls := 0
	ackCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Agent-Bridge-Token"); got != testBridgeToken {
			t.Errorf("bridge token = %q", got)
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["relay_action"] != "poll" {
				t.Errorf("heartbeat body=%#v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"enabled": true})
		case strings.HasSuffix(r.URL.Path, "/commands/claim"):
			claimCalls++
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if claimID, _ := body["claim_id"].(string); len(claimID) != 36 {
				t.Errorf("claim body=%#v", body)
			}
			if claimCalls == 1 {
				_ = json.NewEncoder(w).Encode(map[string]any{"message": map[string]any{
					"message_id": "message-12345678", "sequence": 1, "kind": "message",
					"prompt_id": nil, "content": "continue safely", "attempts": 1,
					"lease_owner": "lease-12345678", "created_at": "2026-07-29T10:00:00Z",
				}})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"message": nil})
		case strings.HasSuffix(r.URL.Path, "/ack"):
			ackCalls++
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "accepted"})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	activatePortalBroker(t, server)

	var waitOut, waitErr bytes.Buffer
	if code := RunCommand([]string{"wait", "--seconds", "0"}, &waitOut, &waitErr); code != 0 {
		t.Fatalf("wait code=%d stderr=%q", code, waitErr.String())
	}
	if !strings.Contains(waitOut.String(), `"lease_owner":"lease-12345678"`) || ackCalls != 0 {
		t.Fatalf("wait output=%q ack calls=%d", waitOut.String(), ackCalls)
	}

	var acceptOut, acceptErr bytes.Buffer
	if code := RunCommand([]string{"accept", "--message-id", "message-12345678", "--lease-owner", "lease-12345678"}, &acceptOut, &acceptErr); code != 0 {
		t.Fatalf("accept code=%d stderr=%q", code, acceptErr.String())
	}
	if ackCalls != 1 || !strings.Contains(acceptOut.String(), `"status":"accepted"`) {
		t.Fatalf("accept output=%q ack calls=%d", acceptOut.String(), ackCalls)
	}
}

func TestBrokerRejectsPrivilegedPathsAndCleansUp(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("forbidden request reached upstream: %s", r.URL.Path)
	}))
	defer server.Close()
	broker := activatePortalBroker(t, server)
	session, err := SessionFromEnvironment(time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	err = doJSON(context.Background(), session.http, session.BaseURL, http.MethodPost, "/admin/agent-portal/state", map[string]any{}, "", "", &out)
	if !portalErrorCode(err, "broker_operation_forbidden") {
		t.Fatalf("expected broker_operation_forbidden, got %v", err)
	}
	dir := broker.dir
	if err := broker.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("broker directory still exists: %v", err)
	}
}

func TestFinishRetriesAnAmbiguousResponseWithTheSameTerminalOperation(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if !strings.HasSuffix(r.URL.Path, "/finish") {
			t.Errorf("path = %s", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["status"] != "completed" || body["summary"] != "done" {
			t.Errorf("body = %#v", body)
		}
		if calls == 1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Fatal(err)
			}
			_ = conn.Close()
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	session := &Session{
		ID: "session-12345678", BridgeToken: testBridgeToken, BaseURL: server.URL,
		Engine: config.EngineCodex, http: server.Client(),
	}

	if err := session.Finish("completed", "done"); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if err := session.Finish("completed", "done"); err != nil {
		t.Fatalf("idempotent local Finish: %v", err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want one retry and no third request", calls)
	}
}

func TestFinishRetryGetsAFreshContextAfterTimeout(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			<-r.Context().Done()
			return nil, r.Context().Err()
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{}`)),
			Request:    r,
		}, nil
	})}
	session := &Session{
		ID: "session-12345678", BridgeToken: testBridgeToken, BaseURL: "http://portal.invalid",
		Engine: config.EngineCodex, http: client, retryAttemptTimeout: 20 * time.Millisecond,
	}

	if err := session.Finish("completed", "done"); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want timeout plus a fresh-context retry", calls)
	}
}

func TestEventRetriesBrokerUpstreamFailureWithStableEventID(t *testing.T) {
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		if len(bodies) == 1 {
			w.WriteHeader(http.StatusBadGateway)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": "broker_upstream_unavailable", "message": "Portal relay is unavailable",
			})
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	session := &Session{
		ID: "session-12345678", BridgeToken: testBridgeToken, BaseURL: server.URL,
		Engine: config.EngineCodex, http: server.Client(), retryAttemptTimeout: time.Second,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := session.Event(ctx, "event-stable-123", "attention", map[string]any{"summary": "check"}); err != nil {
		t.Fatalf("Event: %v", err)
	}
	if len(bodies) != 2 || bodies[0]["client_event_id"] != bodies[1]["client_event_id"] {
		t.Fatalf("event retry bodies = %#v", bodies)
	}
}

func TestClaimRetriesAmbiguousResponseWithStableClaimID(t *testing.T) {
	var claimIDs []string
	var waits []float64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		claimIDs = append(claimIDs, body["claim_id"].(string))
		waits = append(waits, body["wait_seconds"].(float64))
		if len(claimIDs) == 1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Fatal(err)
			}
			_ = conn.Close()
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"message": map[string]any{
			"message_id": "message-12345678", "sequence": 1, "kind": "message",
			"prompt_id": nil, "content": "continue", "attempts": 1,
			"lease_owner": body["claim_id"], "created_at": "2026-07-29T10:00:00Z",
		}})
	}))
	defer server.Close()
	session := &Session{
		ID: "session-12345678", BridgeToken: testBridgeToken, BaseURL: server.URL,
		Engine: config.EngineCodex, http: server.Client(),
	}
	claimID := "22222222-2222-4222-8222-222222222222"

	message, err := claimWithRetry(session, claimID, 1)
	if err != nil {
		t.Fatalf("claimWithRetry: %v", err)
	}
	if message == nil || message.LeaseOwner != claimID {
		t.Fatalf("message = %#v", message)
	}
	if len(claimIDs) != 2 || claimIDs[0] != claimID || claimIDs[1] != claimID {
		t.Fatalf("claim IDs = %#v", claimIDs)
	}
	if len(waits) != 2 || waits[0] != 1 || waits[1] != 0 {
		t.Fatalf("wait seconds = %#v", waits)
	}
}

func TestBrokerCloseCancelsTheLocalSideOfAnActiveLongPoll(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		_, _ = w.Write([]byte(`{"message":null}`))
	}))
	defer server.Close()
	broker := activatePortalBroker(t, server)
	session, err := SessionFromEnvironment(30 * time.Second)
	if err != nil {
		t.Fatal(err)
	}
	claimDone := make(chan error, 1)
	go func() {
		_, claimErr := session.Claim(context.Background(), 25, "11111111-1111-4111-8111-111111111111")
		claimDone <- claimErr
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("long poll did not reach upstream")
	}
	startedAt := time.Now()
	if err := broker.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if elapsed := time.Since(startedAt); elapsed > 2*time.Second {
		t.Fatalf("Close took %s", elapsed)
	}
	select {
	case err := <-claimDone:
		if err == nil {
			t.Fatal("claim unexpectedly succeeded after broker close")
		}
	case <-time.After(time.Second):
		t.Fatal("claim remained blocked after broker close")
	}
	// A transport may finish unwinding its upstream RoundTrip asynchronously;
	// release the test server. Production requests remain bounded by the claim
	// context plus the transport's response-header ceiling.
	close(release)
}

func activatePortalBroker(t *testing.T, server *httptest.Server) *Broker {
	t.Helper()
	session := &Session{
		ID: "session-12345678", BridgeToken: testBridgeToken, BaseURL: server.URL,
		Engine: config.EngineCodex, http: server.Client(),
	}
	broker, err := session.StartBroker(context.Background())
	if err != nil {
		t.Fatalf("StartBroker: %v", err)
	}
	restore := broker.ActivateEnvironment()
	t.Cleanup(func() {
		restore()
		_ = broker.Close()
	})
	return broker
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

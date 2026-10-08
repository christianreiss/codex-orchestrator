package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNativeSessionHookDecodesBothEngineSpellings(t *testing.T) {
	for _, payload := range []string{
		`{"session_id":"native-session"}`,
		`{"sessionId":"native-session"}`,
		`{"session_id":"native-session","sessionId":"other-session"}`,
	} {
		t.Run(payload, func(t *testing.T) {
			socket := filepath.Join(t.TempDir(), "broker.sock")
			listener, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				var body map[string]string
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if req.URL.Path != "/host/agent-sessions/session/receiver/native" || body["native_session_id"] != "native-session" {
					t.Errorf("unexpected native identity: %s %v", req.URL.Path, body)
				}
				_, _ = io.WriteString(w, `{}`)
			})}
			t.Cleanup(func() { _ = server.Close() })
			go func() { _ = server.Serve(listener) }()
			t.Setenv(envSocket, socket)
			t.Setenv(envSessionID, "session")
			if err := reportNativeSession(strings.NewReader(payload)); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRequestWaitFailurePreservesDurableSend(t *testing.T) {
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		status, body := 200, `{"created":true,"message":{"id":"message","conversation_id":"conversation","sequence":1}}`
		if strings.HasSuffix(req.URL.Path, "/wait") {
			status, body = 503, `{"message":"temporary outage"}`
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	out, err := callMCPTool(context.Background(), client, newChannelTracker(client), "agent_request", map[string]any{"to": "peer", "content": "check fixture", "wait_seconds": 0})
	if err != nil {
		t.Fatalf("a wait failure hides an already accepted send: %v", err)
	}
	sent, _ := out["sent"].(map[string]any)
	message, _ := sent["message"].(map[string]any)
	if message["id"] != "message" || out["wait_error"] == nil {
		t.Fatalf("lost retry context: %v", out)
	}
}

func TestDirectSendRetainsCallerRetryID(t *testing.T) {
	const id = "d8e3b755-727f-4661-98cf-7d927bec37fe"
	var ids []string
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		if strings.HasSuffix(req.URL.Path, "/send") || strings.HasSuffix(req.URL.Path, "/call/join") {
			ids = append(ids, stringArg(body, "client_message_id"))
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"message":{"id":"message","conversation_id":"conversation","sequence":1}}`))}, nil
	})}}
	for _, name := range []string{"agent_send", "agent_request", "agent_call_join"} {
		if _, err := callMCPTool(context.Background(), client, newChannelTracker(client), name, map[string]any{"to": "peer", "pin": "0042", "content": "check fixture", "client_message_id": id, "wait_seconds": 0}); err != nil {
			t.Fatal(err)
		}
	}
	if len(ids) != 3 || ids[0] != id || ids[1] != id || ids[2] != id {
		t.Fatalf("retry IDs changed: %v", ids)
	}
}

func TestCompletionStorageKeepsTheAcceptedLeaseAlive(t *testing.T) {
	var renewed atomic.Int32
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	client := &relayClient{id: "relay", baseURL: "https://fixture.invalid", completionRenewEvery: time.Millisecond}
	client.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/renew") {
			renewed.Add(1)
		} else {
			// Result storage is slow after the native child has already exited.
			select {
			case <-time.After(25 * time.Millisecond):
			case <-req.Context().Done():
				return nil, req.Context().Err()
			}
			if renewed.Load() == 0 {
				t.Error("completion storage abandoned its delivery lease")
			}
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}
	delivery := &relayDelivery{MessageID: "message", ClaimID: "claim", WorkKind: "request"}
	if err := client.completeTask(ctx, delivery, &taskResult{Status: "succeeded", Summary: "fixture passed"}, &nativeResult{}); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeProvesItsPipesBeforeAdvertisingReadiness(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	var delivered atomic.Int32
	var pinged atomic.Bool
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := &autoReceiver{}
	r.output = &mcpWriter{w: lifecycleWriter(func(data []byte) (int, error) {
		n, err := (receiverHealthWriter{r: r, deliveries: &delivered}).Write(data)
		if err == nil && strings.Contains(string(data), `"method":"ping"`) {
			pinged.Store(true)
		}
		return n, err
	})}
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `{"native_session_id":"native"}`
		if strings.HasSuffix(req.URL.Path, "/register") {
			r.mu.Lock()
			proved := pinged.Load() && r.pendingPing == "" && !r.lastPong.IsZero()
			r.mu.Unlock()
			if !proved {
				t.Error("receiver registered before a successful current ping")
			}
			cancel()
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	r.client, r.tracker = client, newChannelTracker(client)
	_ = r.connection(ctx)
	if delivered.Load() != 0 {
		t.Fatal("health used a model turn")
	}
}

type lifecycleWriter func([]byte) (int, error)

func (w lifecycleWriter) Write(data []byte) (int, error) { return w(data) }

func TestWrongReplyToolNamesTheOwnedDeliverySource(t *testing.T) {
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		t.Fatal("misrouted reply must not be sent to either API")
		return nil, io.ErrUnexpectedEOF
	})}}
	tracker := newChannelTracker(client)
	tracker.items["peer"] = &channelPending{claimID: "claim"}
	tracker.receiver = &autoReceiver{client: client, tracker: tracker, pendingPortal: map[string]any{"message_id": "portal"}}
	for _, tc := range []struct{ tool, id, hint string }{
		{"agent_receiver_reply", "peer", "call agent_reply"},
		{"agent_reply", "portal", "call agent_receiver_reply"},
		{"agent_task_result", "portal", "call agent_receiver_reply"},
	} {
		_, err := callMCPTool(context.Background(), client, tracker, tc.tool, map[string]any{"message_id": tc.id, "content": "fixture"})
		if err == nil || !strings.Contains(err.Error(), tc.hint) {
			t.Fatalf("%s: missing recovery guidance: %v", tc.tool, err)
		}
	}
}

func TestLostCompletionResponseStillConfirmsAfterTerminalRenewal(t *testing.T) {
	var stored atomic.Int32
	var renewals atomic.Int32
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client := &relayClient{id: "relay", baseURL: "https://fixture.invalid", completionRenewEvery: time.Millisecond}
	client.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		status, body := 200, `{}`
		if strings.HasSuffix(req.URL.Path, "/renew") {
			renewals.Add(1)
			status, body = 409, `{"code":"agent_messaging_lease_lost","message":"already completed"}`
		} else if stored.Add(1) == 1 {
			time.Sleep(25 * time.Millisecond)
			return nil, io.ErrUnexpectedEOF
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	if err := client.completeTask(ctx, &relayDelivery{MessageID: "message", ClaimID: "claim", WorkKind: "request"}, &taskResult{Status: "succeeded", Summary: "done"}, &nativeResult{}); err != nil {
		t.Fatal(err)
	}
	if stored.Load() != 2 || renewals.Load() == 0 {
		t.Fatalf("storage=%d renewals=%d", stored.Load(), renewals.Load())
	}
}

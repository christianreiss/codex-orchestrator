package agentportal

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

// A normal exit must not trigger session disconnect before the terminal write.
// Only session presence stays live; native ownership has already ended.
func TestCloseRetainsSessionAttachmentUntilTerminalReceipt(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		for _, failure := range []bool{false, true} {
			t.Run(engine+map[bool]string{false: "/success", true: "/failed_receipt"}[failure], func(t *testing.T) {
				socket := filepath.Join(t.TempDir(), "state.sock")
				listener, err := net.Listen("unix", socket)
				if err != nil {
					t.Fatal(err)
				}
				disconnected := make(chan struct{})
				stateServer := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
					defer ws.Close()
					defer close(disconnected)
					var open communicator.StateFrame
					if websocket.JSON.Receive(ws, &open) != nil {
						return
					}
					if open.Scope.NativeInstanceID != "" {
						t.Error("shutdown retained native-instance ownership")
					}
					frame := communicator.StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: uuid.NewString(), Revision: "1", Payload: json.RawMessage(`{"ownership_mode":"connection","authorization_deadline":null,"session":{}}`)}
					if websocket.JSON.Send(ws, frame) != nil {
						return
					}
					for {
						var frame communicator.StateFrame
						if websocket.JSON.Receive(ws, &frame) != nil {
							return
						}
					}
				})}
				go stateServer.Serve(listener)
				defer stateServer.Close()
				original := dialPortalState
				defer func() { dialPortalState = original }()
				dialPortalState = func(ctx context.Context, _ string, scope communicator.StateScope, auth communicator.StateAuth) (*communicator.StateClient, error) {
					return communicator.DialStateSocket(ctx, socket, "/state", scope, auth)
				}
				finishStarted, allowReceipt := make(chan struct{}), make(chan struct{})
				var signalFinish sync.Once
				var session *Session
				var broker *Broker
				api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if !strings.HasSuffix(r.URL.Path, "/finish") {
						t.Errorf("unexpected exit request: %s", r.URL.Path)
					}
					if _, _, live, _ := session.stateView(); !live {
						t.Error("session attachment lost before terminal receipt")
					}
					if _, err := os.Stat(broker.socketPath); !errors.Is(err, os.ErrNotExist) {
						t.Errorf("broker capability not revoked before finish: %v", err)
					}
					if _, cancel, err := session.beginBridgeRequest(context.Background(), false); err == nil {
						cancel()
						t.Error("normal bridge request admitted during finalization")
					}
					signalFinish.Do(func() { close(finishStarted) })
					<-allowReceipt
					if failure {
						w.WriteHeader(http.StatusInternalServerError)
					}
					io.WriteString(w, `{}`)
				}))
				defer api.Close()
				defer func() {
					select {
					case <-allowReceipt:
					default:
						close(allowReceipt)
					}
				}()
				session = &Session{ID: uuid.NewString(), Engine: engine, BridgeToken: "fixture", BaseURL: api.URL, http: api.Client()}
				stop := session.StartHeartbeat(context.Background())
				defer stop()
				select {
				case <-session.stateNegotiated():
				case <-time.After(time.Second):
					t.Fatal("no session attachment")
				}
				broker, err = session.StartBroker(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				defer broker.Close()
				activeRequest, cancelRequest, err := session.beginBridgeRequest(context.Background(), false)
				if err != nil {
					t.Fatal(err)
				}
				defer cancelRequest()
				runtime := &ConnectionRuntime{session: session, broker: broker, stopHeartbeat: stop, restore: func() {}}
				done := make(chan error, 1)
				go func() { done <- runtime.Close("completed", "native exited") }()
				select {
				case <-finishStarted:
				case <-time.After(2 * time.Second):
					t.Fatal("finish did not start")
				}
				select {
				case <-disconnected:
					t.Error("attachment disconnected while receipt was pending")
				default:
				}
				select {
				case <-activeRequest.Done():
				case <-time.After(time.Second):
					t.Error("normal in-flight request not canceled")
				}
				close(allowReceipt)
				select {
				case err := <-done:
					if (err != nil) != failure {
						t.Errorf("close error=%v failure=%v", err, failure)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("close did not finish")
				}
				select {
				case <-disconnected:
				case <-time.After(time.Second):
					t.Fatal("attachment retained after close")
				}
				if _, _, live, _ := session.stateView(); live {
					t.Error("session presence retained after close")
				}
			})
		}
	}
}

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

func TestFinishRetriesCommunicatorUnknownWithoutReplayingOtherWrites(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					w.WriteHeader(409)
					io.WriteString(w, `{"error":{"code":"communicator_outcome_unknown","message":"Local communicator disconnected; request outcome unknown"}}`)
					return
				}
				io.WriteString(w, `{}`)
			}))
			defer server.Close()
			session := &Session{ID: "session", Engine: engine, BridgeToken: "bridge", BaseURL: server.URL, http: server.Client()}
			if err := session.Finish("completed", "done"); err != nil {
				t.Fatal(err)
			}
			if err := session.Finish("completed", "done"); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 2 {
				t.Fatalf("finish requests=%d", calls.Load())
			}
			if isRetryableAmbiguous(&PortalError{Status: 409, Code: "communicator_outcome_unknown"}) {
				t.Fatal("other non-idempotent writes must not gain automatic replay")
			}
		})
	}
}

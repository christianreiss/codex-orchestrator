package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

func TestKimiReceiverOwnsStateWithoutClaimingIdleWork(t *testing.T) {
	for _, reason := range []string{"server disconnect", "local cancellation"} {
		t.Run(reason, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv("CXX_AGENT_PORTAL_ENGINE", "kimi")
			socket := filepath.Join(t.TempDir(), "r.sock")
			listener, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			admitted := make(chan bool, 1)
			disconnect := make(chan struct{})
			stopped := make(chan bool, 1)
			mux := http.NewServeMux()
			mux.Handle("/_state", websocket.Handler(func(ws *websocket.Conn) {
				defer ws.Close()
				ws.SetDeadline(time.Now().Add(3 * time.Second))
				var open communicator.StateFrame
				if err := websocket.JSON.Receive(ws, &open); err != nil {
					t.Error(err)
					return
				}
				if open.Scope == nil || open.Scope.Topic != "receiver" || open.Scope.SessionID != "launch" || open.Scope.Engine != "kimi" || open.Scope.BindingGeneration != 7 || open.Scope.ReceiverGeneration == "" {
					t.Errorf("receiver scope %#v", open.Scope)
					return
				}
				frame := communicator.StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: uuid.NewString(), Revision: "1", Payload: json.RawMessage(`{"ownership_mode":"connection","sources":["peer"],"work_revision":"1"}`)}
				if err := websocket.JSON.Send(ws, frame); err != nil {
					t.Error(err)
					return
				}
				for {
					var msg communicator.StateFrame
					if err := websocket.JSON.Receive(ws, &msg); err != nil {
						return
					}
					if msg.Type == "state_update" {
						var update struct {
							Generation string
							Capacity   bool
							Gate       struct{ State string }
						}
						if err := json.Unmarshal(msg.Payload, &update); err != nil || update.Generation != open.Scope.ReceiverGeneration || update.Capacity || update.Gate.State != "thread_waiting" {
							t.Errorf("Kimi gate %s, %v", msg.Payload, err)
						}
						admitted <- true
						if reason == "server disconnect" {
							<-disconnect
							return
						}
					}
				}
			}))
			mux.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
				switch filepath.Base(req.URL.Path) {
				case "native":
					_ = json.NewEncoder(w).Encode(map[string]string{"native_session_id": testKimiID})
				case "register":
					io.WriteString(w, `{"sources":["peer"],"binding_generation":7,"capabilities":{"control_state_protocol":1}}`)
				case "stop":
					stopped <- true
					io.WriteString(w, "{}")
				default:
					t.Errorf("unexpected background operation %s", req.URL.Path)
					w.WriteHeader(400)
				}
			})
			server := http.Server{Handler: mux}
			go server.Serve(listener)
			defer server.Close()
			c := sessionClientAt(socket, "launch", 2*time.Second)
			r := &autoReceiver{client: c, tracker: newChannelTracker(c)}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- r.connection(ctx) }()
			select {
			case <-admitted:
			case <-time.After(2 * time.Second):
				t.Fatal("missing Kimi receiver state attachment")
			}
			if got := r.awaitReady(ctx, time.Second)["state"]; got != "ready" {
				t.Errorf("attached receiver %v", got)
			}
			if reason == "server disconnect" {
				close(disconnect)
			} else {
				cancel()
			}
			select {
			case e := <-done:
				if reason == "local cancellation" && !errors.Is(e, context.Canceled) {
					t.Errorf("cancel result %v", e)
				}
				if reason == "server disconnect" && (e == nil || !strings.Contains(e.Error(), "disconnected")) {
					t.Errorf("disconnect result %v", e)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("receiver survived loss of its authority")
			}
			if r.health()["state"] == "ready" {
				t.Error("detached receiver still ready")
			}
			select {
			case <-stopped:
			default:
				t.Error("detached generation not stopped")
			}
		})
	}
}

func TestReceiverCannotDowngradeNegotiatedState(t *testing.T) {
	r := &autoReceiver{client: &sessionClient{id: "launch", socket: filepath.Join(t.TempDir(), "missing")}}
	ctx := context.Background()
	if s, e := r.openReceiverState(ctx, "kimi", "gen", 1, false); s != nil || e != nil {
		t.Fatal("legacy registration without state", s, e)
	}
	if _, e := r.openReceiverState(ctx, "kimi", "gen", 1, true); e == nil {
		t.Fatal("missing required stream granted presence")
	}
	r.connectionOwned = true
	if _, e := r.openReceiverState(ctx, "kimi", "gen", 1, false); e == nil {
		t.Fatal("negotiated connection fell back to leases")
	}
}

func TestKimiListenUsesOneReceiveAuthority(t *testing.T) {
	for _, mode := range []string{"active receiver", "standalone listener"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv("CXX_AGENT_PORTAL_ENGINE", "kimi")
			const generation = "receiver-generation"
			const msg = "11111111-1111-4111-8111-111111111111"
			binds, claims, accepts := 0, 0, 0
			var lease string
			api := roundTripFunc(func(req *http.Request) (*http.Response, error) {
				var body map[string]any
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				res := httptest.NewRecorder()
				switch filepath.Base(req.URL.Path) {
				case "native":
					_ = json.NewEncoder(res).Encode(map[string]string{"native_session_id": testKimiID})
				case "mailbox":
					io.WriteString(res, `{"pending":[]}`)
				case "bind":
					binds++
					if mode == "active receiver" {
						res.WriteHeader(409)
						io.WriteString(res, `{"code":"receiver_owned"}`)
					} else {
						io.WriteString(res, "{}")
					}
				case "claim":
					claims++
					lease = stringArg(body, "claim_id")
					if (body["receiver_generation"] == generation) != (mode == "active receiver") || lease == "" {
						t.Errorf("claim authority %#v", body)
					}
					delivery := map[string]any{"message_id": msg, "content": "fixture"}
					if mode == "active receiver" {
						delivery["work_kind"] = "request"
					}
					_ = json.NewEncoder(res).Encode(map[string]any{"delivery": delivery})
				case "ack":
					if body["outcome"] != "accepted" || body["claim_id"] != lease {
						t.Errorf("unexpected ACK %#v", body)
					}
					accepts++
					io.WriteString(res, `{"message":{"status":"accepted"}}`)
				default:
					t.Errorf("unexpected listen operation %s", req.URL.Path)
					res.WriteHeader(400)
				}
				return res.Result(), nil
			})
			c := &sessionClient{id: "launch", http: &http.Client{Transport: api}}
			tracker := newChannelTracker(c)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "active receiver" {
				tracker.receiver = &autoReceiver{client: c, tracker: tracker, connected: true, sources: []string{"peer"}, generation: generation, boundNativeID: testKimiID, lastBeatOK: time.Now()}
			}
			reply, err := callMCPTool(ctx, c, tracker, "agent_listen", map[string]any{"wait_seconds": 0})
			wantAccepts := 0
			if mode == "active receiver" {
				wantAccepts = 1
			}
			if err != nil || reply["message_id"] != msg || claims != 1 || accepts != wantAccepts {
				t.Fatalf("result=%v claims=%d accepts=%d error=%v", reply, claims, accepts, err)
			}
			if (binds == 1) != (mode == "standalone listener") || binds > 1 {
				t.Errorf("expected exactly one receive authority, saw %d additional binds", binds)
			}
		})
	}
}

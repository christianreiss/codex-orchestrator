package agentbus

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func TestNativeActivityMapping(t *testing.T) {
	for _, tc := range []struct {
		state        string
		flags        []string
		want, reason string
	}{
		{"idle", nil, "idle", ""}, {"active", nil, "working", ""},
		{"active", []string{"waitingOnApproval"}, "waiting", "approval"},
		{"active", []string{"waitingOnUserInput"}, "waiting", "input"},
		{"notLoaded", nil, "unknown", ""}, {"future", nil, "unknown", ""},
	} {
		a := codexActivity(tc.state, tc.flags)
		reason := ""
		if a.WaitReason != nil {
			reason = *a.WaitReason
		}
		if a.State != tc.want || reason != tc.reason {
			t.Fatalf("%+v: %+v", tc, a)
		}
	}
	for state, want := range map[string]string{"working": "working", "idle": "idle", "needs_input": "waiting", "dormant": "unknown", "dead": "unknown", "future": "unknown"} {
		if a := grokActivity(state); a.State != want {
			t.Fatalf("%s: %+v", state, a)
		}
	}
}

func TestActivityReaderFailureReturnsNil(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	t.Setenv("CXX_GROK_SOCKET", "/nonexistent/cxx-activity.sock")
	reader, err := openActivityReader(ctx, "grok", "native")
	if err == nil || reader != nil {
		t.Fatal("failed reader must not return a typed nil interface")
	}
}

// End-to-end adapter transport: the observer must run even while delivery is
// held, never answer reverse approvals, and survive a lost server receipt.
func TestActivityObserverIndependentOfDelivery(t *testing.T) {
	nativeSocket := filepath.Join(t.TempDir(), "native.sock")
	listener, err := net.Listen("unix", nativeSocket)
	if err != nil {
		t.Fatal(err)
	}
	var stage atomic.Int32
	native := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		for {
			var req struct {
				ID     int            `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if websocket.JSON.Receive(ws, &req) != nil {
				return
			}
			if req.Method == "initialized" {
				continue
			}
			out := map[string]any{}
			switch req.Method {
			case "initialize":
			case "thread/read":
				if req.Params["threadId"] != "bound" || req.Params["includeTurns"] != false {
					t.Error("observer lost binding or read contents")
				}
				status := map[string]any{"type": "active"}
				if stage.Load() == 1 {
					status["activeFlags"] = []string{"waitingOnApproval"}
				}
				if stage.Load() >= 2 {
					status = map[string]any{"type": "idle"}
				}
				out["thread"] = map[string]any{"status": status}
				_ = websocket.JSON.Send(ws, map[string]any{"id": "approval", "method": "item/commandExecution/requestApproval"})
			default:
				t.Errorf("observer sent non-observation RPC: %s", req.Method)
			}
			if websocket.JSON.Send(ws, map[string]any{"id": req.ID, "result": out}) != nil {
				return
			}
		}
	})}
	go native.Serve(listener)
	defer native.Close()
	socket := filepath.Join(t.TempDir(), "broker.sock")
	brokerListener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	reports := make(chan map[string]any, 8)
	var attempts atomic.Int32
	broker := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/host/agent-sessions/session/activity" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if attempts.Add(1) == 1 {
			w.WriteHeader(503)
			return
		}
		reports <- body
		stage.Add(1)
		_, _ = w.Write([]byte(`{"accepted":true}`))
	})}
	go broker.Serve(brokerListener)
	defer broker.Close()
	t.Setenv("CXX_CODEX_SOCKET", nativeSocket)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	receiver := &autoReceiver{client: sessionClientAt(socket, "session", time.Second), pendingPortal: map[string]any{"message_id": "held"}}
	done := make(chan struct{})
	go func() { defer close(done); receiver.observeActivity(ctx, "codex", "bound", "generation", 7) }()
	lastSeq := float64(0)
	for _, want := range []string{"working", "waiting", "idle"} {
		select {
		case body := <-reports:
			if body["state"] != want || body["native_session_id"] != "bound" || body["binding_generation"] != float64(7) || body["generation"] != "generation" {
				t.Fatalf("bad observation: %+v", body)
			}
			if body["sequence"].(float64) <= lastSeq {
				t.Fatal("sequence regressed")
			}
			lastSeq = body["sequence"].(float64)
		case <-ctx.Done():
			t.Fatal("missing native transition")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("observer did not stop")
	}
}

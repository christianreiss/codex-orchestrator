package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
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

// Capture the actual observer HTTP payload, then pass those bytes through the
// real TypeScript API schema when Node is available. The optional artifact lets
// the host run that same validator when the Go build image has no Node runtime.
func TestClaudeActivityObserverWireMatchesStrictAPISchema(t *testing.T) {
	const generation = "11111111-1111-4111-8111-111111111111"
	const epoch = "22222222-2222-4222-8222-222222222222"
	const instance = "33333333-3333-4333-8333-333333333333"
	socket := filepath.Join(t.TempDir(), "broker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	var stage atomic.Int32
	reports := make(chan json.RawMessage, 8)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/host/agent-sessions/session/receiver/activity-hook":
			json.NewEncoder(w).Encode(map[string]any{"state": "idle", "wait_reason": nil, "source": "claude-hooks", "evidence_age_ms": 0,
				"turn_proof": map[string]any{"epoch": epoch, "sequence": 7 + stage.Load(), "state": "idle", "native_instance_id": instance, "binding_generation": 7}})
		case "/host/agent-sessions/session/activity":
			var body json.RawMessage
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				w.WriteHeader(400)
				return
			}
			reports <- body
			stage.Store(1)
			w.Write([]byte(`{"accepted":true}`))
		default:
			t.Errorf("wrong wire endpoint: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})}
	go server.Serve(listener)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	receiver := &autoReceiver{client: sessionClientAt(socket, "session", time.Second), generation: generation, deliveryTimingV1: true}
	done := make(chan struct{})
	go func() { defer close(done); receiver.observeActivity(ctx, "claude", "native-claude", generation, 7) }()
	var captured []json.RawMessage
	for _, expected := range []string{"unknown", "idle"} {
		select {
		case raw := <-reports:
			captured = append(captured, raw)
			var body map[string]json.RawMessage
			if json.Unmarshal(raw, &body) != nil {
				t.Fatal("invalid JSON")
			}
			if _, exists := body["native_instance_id"]; exists {
				t.Error("observer sent redundant top-level native_instance_id rejected by strict activityInputSchema")
			}
			var proof struct {
				State    string `json:"state"`
				Instance string `json:"native_instance_id"`
				Sequence int    `json:"sequence"`
			}
			if json.Unmarshal(body["turn_proof"], &proof) != nil || proof.State != expected || proof.Instance != instance {
				t.Fatalf("lost ordered native proof: %s", raw)
			}
		case <-ctx.Done():
			t.Fatal("missing observer payload")
		}
	}
	cancel()
	<-done
	wire, err := json.Marshal(captured)
	if err != nil {
		t.Fatal(err)
	}
	if artifact := os.Getenv("CXX_ACTIVITY_SCHEMA_FIXTURE"); artifact != "" {
		if err := os.WriteFile(artifact, wire, 0600); err != nil {
			t.Fatal(err)
		}
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Log("Node absent: validate exported actual observer fixture against activityInputSchema on host")
		return
	}
	apiRoot, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "api"))
	if err != nil {
		t.Fatal(err)
	}
	// The negative control proves the real strict parser rejects the original
	// extra-field regression, rather than silently stripping unknown fields.
	script := `import {readFileSync} from 'node:fs'; import {activityInputSchema} from './src/services/agent-activity.ts';
for (const body of JSON.parse(readFileSync(0,'utf8'))) { activityInputSchema.parse(body); if(activityInputSchema.safeParse({...body,native_instance_id:body.turn_proof.native_instance_id}).success) throw Error('strict-schema control failed'); }`
	command := exec.Command(node, "--import", "tsx", "--input-type=module", "-e", script)
	command.Dir = apiRoot
	command.Stdin = bytes.NewReader(wire)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("actual Go observer payload rejected by actual API schema: %v\n%s", err, output)
	}
}

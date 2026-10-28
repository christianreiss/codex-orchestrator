package agentportal

import (
	"context"
	"encoding/json"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/google/uuid"
	"golang.org/x/net/websocket"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestClaudeHookEvidenceExpiresAndCannotCrossSessions(t *testing.T) {
	b := &Broker{session: &Session{Engine: "claude"}, nativeID: "native"}
	send := func(body string) ActivityObservation {
		t.Helper()
		w := httptest.NewRecorder()
		b.activityHook(w, []byte(body))
		if w.Code != 200 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		var a ActivityObservation
		_ = json.Unmarshal(w.Body.Bytes(), &a)
		return a
	}
	if a := send(`{"native_session_id":"native","event":"UserPromptSubmit"}`); a.State != "working" {
		t.Fatal(a)
	}
	b.hookActivityAt = time.Now().Add(-46 * time.Second)
	if a := send(`{}`); a.State != "unknown" || a.EvidenceAgeMS < 46000 {
		t.Fatal(a)
	}
	if a := send(`{"native_session_id":"native","event":"PermissionRequest"}`); a.State != "waiting" || *a.WaitReason != "approval" {
		t.Fatal(a)
	}
	w := httptest.NewRecorder()
	b.activityHook(w, []byte(`{"native_session_id":"other","event":"Stop"}`))
	if w.Code != 409 {
		t.Fatal(w.Code)
	}
	b.nativeID = "other"
	if a := send(`{}`); a.State != "unknown" {
		t.Fatal(a)
	}
	if a := send(`{"native_session_id":"other","event":"UserPromptSubmit"}`); a.State != "working" {
		t.Fatal(a)
	}
	// A reporter from the previous native binding cannot read the new evidence.
	if a := send(`{"native_session_id":"native"}`); a.State != "unknown" {
		t.Fatal(a)
	}
}

func TestClaudeHookMetadataMapping(t *testing.T) {
	for event, want := range map[string]string{"PreToolUse": "working", "PostToolUse": "working", "PostToolUseFailure": "working", "Stop": "idle", "StopFailure": "idle", "SessionEnd": "unknown", "SessionStart": "unknown", "Elicitation": "waiting", "ElicitationResult": "working", "future": "unknown"} {
		if a := ClaudeActivity(ActivityHook{Event: event}); a.State != want {
			t.Fatalf("%s: %+v", event, a)
		}
	}
	if a := ClaudeActivity(ActivityHook{Event: "PreToolUse", Tool: "AskUserQuestion"}); a.State != "waiting" {
		t.Fatal(a)
	}
}

func TestClaudeTurnProofRetainsStopBeyondActivityTTLAndRejectsKnownResets(t *testing.T) {
	b := &Broker{session: &Session{Engine: "claude"}, nativeID: "native"}
	instance := "11111111-1111-4111-8111-111111111111"
	unknown := b.updateClaudeTurnProof("native", instance, 7, "")
	if unknown.State != "unknown" || unknown.Sequence != 1 || unknown.Epoch == "" {
		t.Fatal(unknown)
	}
	idle := b.updateClaudeTurnProof("native", instance, 7, "Stop")
	b.hookActivityAt = time.Now().Add(-24 * time.Hour)
	later := b.updateClaudeTurnProof("native", instance, 7, "")
	if idle.State != "idle" || later != idle {
		t.Fatalf("idle proof expired with telemetry: %+v %+v", idle, later)
	}
	for _, event := range []string{"UserPromptSubmit", "PreToolUse", "PermissionRequest", "Elicitation"} {
		active := b.updateClaudeTurnProof("native", instance, 7, event)
		if active.State != "active" || active.Sequence <= later.Sequence {
			t.Fatal(event, active)
		}
	}
	for _, event := range []string{"StopFailure", "SessionStart", "SessionEnd", "future"} {
		if p := b.updateClaudeTurnProof("native", instance, 7, event); p.State != "unknown" {
			t.Fatal(event, p)
		}
	}
	b.updateClaudeTurnProof("native", instance, 7, "Stop")
	changed := b.updateClaudeTurnProof("native", instance, 8, "")
	if changed.State != "unknown" || changed.Sequence != 1 || changed.Epoch == idle.Epoch {
		t.Fatal(changed)
	}
	lost := b.updateClaudeTurnProof("native", "", 0, "")
	if lost.State != "unknown" || lost.Epoch == changed.Epoch {
		t.Fatal(lost)
	}
	b.nativeID = "other"
	if p := b.updateClaudeTurnProof("native", instance, 8, "Stop"); p.State != "unknown" {
		t.Fatal(p)
	}
}

func TestClaudeSessionStartProvesIdleBeforeFirstPrompt(t *testing.T) {
	instance := "11111111-1111-4111-8111-111111111111"
	for source, want := range map[string]string{"startup": "idle", "resume": "idle", "clear": "idle", "compact": "unknown", "": "unknown"} {
		b := &Broker{session: &Session{Engine: "claude"}, nativeID: "native"}
		p := b.updateClaudeTurnProof("native", instance, 7, turnProofEvent(ActivityHook{Event: "SessionStart", Source: source}))
		if p.State != want {
			t.Fatal(source, p)
		}
	}
	b := &Broker{session: &Session{Engine: "claude"}, nativeID: "native"}
	b.updateClaudeTurnProof("native", instance, 7, "UserPromptSubmit")
	if p := b.updateClaudeTurnProof("native", instance, 7, turnProofEvent(ActivityHook{Event: "SessionStart", Source: "startup"})); p.State != "active" {
		t.Fatal("late SessionStart downgraded an active turn", p)
	}
}

func TestClaudeChannelDeliveryNeverCallsOwnerWithoutNativeProof(t *testing.T) {
	b := &Broker{session: &Session{ID: "fixture", Engine: "claude"}, nativeID: "native"}
	request := httptest.NewRequest("POST", "/receiver/channel-deliver", nil)
	recorder := httptest.NewRecorder()
	b.channelDeliver(recorder, request, []byte(`{"native_session_id":"native","message_id":"fixture","content":"fixture","delivery_timing":"after_turn"}`))
	if recorder.Code != 409 {
		t.Fatalf("%d %s", recorder.Code, recorder.Body.String())
	}
}

func claudeTurnBrokerFixture(t *testing.T) *Broker {
	t.Helper()
	dir := t.TempDir()
	socket := filepath.Join(dir, "state.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var open communicator.StateFrame
		if websocket.JSON.Receive(ws, &open) != nil {
			return
		}
		frame := communicator.StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: uuid.NewString(), Revision: "1",
			Payload: json.RawMessage(`{"ownership_mode":"connection","authorization_deadline":null,"session":{"binding_generation":7},"native_control":{"instance_id":"11111111-1111-4111-8111-111111111111"}}`)}
		if websocket.JSON.Send(ws, frame) != nil {
			return
		}
		for {
			var next communicator.StateFrame
			if websocket.JSON.Receive(ws, &next) != nil {
				return
			}
		}
	})}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	feed, err := communicator.DialStateSocket(context.Background(), socket, "/state", communicator.StateScope{Topic: "session"}, communicator.StateAuth{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { feed.Close() })
	return &Broker{session: &Session{ID: "fixture", Engine: "claude", nativeState: feed}, dir: dir, nativeID: "native"}
}
func TestClaudeChannelWriteSerializesPromptHookWithoutCancellingWork(t *testing.T) {
	b := claudeTurnBrokerFixture(t)
	entered, finish := make(chan struct{}, 2), make(chan struct{})
	var calls atomic.Int32
	listener, err := net.Listen("unix", filepath.Join(b.dir, "receiver-owner.sock"))
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		entered <- struct{}{}
		<-finish
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"delivered":true,"message_id":"id"}`))
	})}
	go server.Serve(listener)
	defer server.Close()
	stop := httptest.NewRecorder()
	b.activityHook(stop, []byte(`{"native_session_id":"native","event":"Stop"}`))
	deliveryDone := make(chan *httptest.ResponseRecorder, 1)
	send := func(timing string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "/receiver/channel-deliver", nil)
		out := httptest.NewRecorder()
		b.channelDeliver(out, request, []byte(`{"native_session_id":"native","message_id":"id","content":"message","delivery_timing":"`+timing+`"}`))
		return out
	}
	go func() { deliveryDone <- send("after_turn") }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("no callback")
	}
	hookDone := make(chan struct{})
	go func() {
		b.activityHook(httptest.NewRecorder(), []byte(`{"native_session_id":"native","event":"UserPromptSubmit"}`))
		close(hookDone)
	}()
	select {
	case <-hookDone:
		t.Fatal("new prompt passed while channelwrite pending")
	case <-time.After(20 * time.Millisecond):
	}
	close(finish)
	out := <-deliveryDone
	if out.Code != 200 {
		t.Fatalf("%d %s", out.Code, out.Body.String())
	}
	var receipt struct {
		Delivered bool            `json:"delivered"`
		MessageID string          `json:"message_id"`
		Proof     ClaudeTurnProof `json:"turn_proof"`
	}
	if err := json.Unmarshal(out.Body.Bytes(), &receipt); err != nil || !receipt.Delivered || receipt.MessageID != "id" || receipt.Proof.State != "idle" || receipt.Proof.Sequence != 2 || receipt.Proof.NativeInstanceID == "" {
		t.Fatalf("uncorrelated boundary receipt: %s %v", out.Body.String(), err)
	}
	<-hookDone
	if out := send("after_turn"); out.Code != 409 || calls.Load() != 1 {
		t.Fatalf("busy default admitted: %d calls=%d", out.Code, calls.Load())
	}
	if out := send("immediate"); out.Code != 200 || calls.Load() != 2 {
		t.Fatalf("active immediate denied: %d calls=%d", out.Code, calls.Load())
	}
}
func TestClaudeChannelCallbackDisconnectRemainsUnknownAndIsNeverRetried(t *testing.T) {
	b := claudeTurnBrokerFixture(t)
	var calls atomic.Int32
	listener, err := net.Listen("unix", filepath.Join(b.dir, "receiver-owner.sock"))
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
	})}
	go server.Serve(listener)
	defer server.Close()
	b.activityHook(httptest.NewRecorder(), []byte(`{"native_session_id":"native","event":"Stop"}`))
	out := httptest.NewRecorder()
	b.channelDeliver(out, httptest.NewRequest("POST", "/receiver/channel-deliver", nil), []byte(`{"native_session_id":"native","message_id":"id","content":"message","delivery_timing":"after_turn"}`))
	if out.Code != 502 || calls.Load() != 1 {
		t.Fatalf("%d calls=%d %s", out.Code, calls.Load(), out.Body.String())
	}
}

func TestClaudeChannelRejectsUncorrelatedOwnerReceiptsWithoutRetry(t *testing.T) {
	for _, response := range []string{`{"delivered":false,"message_id":"id"}`, `{"delivered":true,"message_id":"other"}`, `{"delivered":true}`, `not-json`} {
		t.Run(response, func(t *testing.T) {
			b := claudeTurnBrokerFixture(t)
			var calls atomic.Int32
			listener, err := net.Listen("unix", filepath.Join(b.dir, "receiver-owner.sock"))
			if err != nil {
				t.Fatal(err)
			}
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.Write([]byte(response)) })}
			go server.Serve(listener)
			defer server.Close()
			b.activityHook(httptest.NewRecorder(), []byte(`{"native_session_id":"native","event":"Stop"}`))
			out := httptest.NewRecorder()
			b.channelDeliver(out, httptest.NewRequest("POST", "/receiver/channel-deliver", nil), []byte(`{"native_session_id":"native","message_id":"id","content":"message","delivery_timing":"after_turn"}`))
			if out.Code != 502 || calls.Load() != 1 {
				t.Fatalf("%d calls=%d %s", out.Code, calls.Load(), out.Body.String())
			}
		})
	}
}

func TestClaudeChannelAbsoluteWriteDeadlineKeepsHookOrderedUntilKnownPrewriteRefusal(t *testing.T) {
	b := claudeTurnBrokerFixture(t)
	entered := make(chan int64, 1)
	listener, err := net.Listen("unix", filepath.Join(b.dir, "receiver-owner.sock"))
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			MessageID string `json:"message_id"`
			Deadline  int64  `json:"write_deadline_ms"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			w.WriteHeader(400)
			return
		}
		entered <- request.Deadline
		// Simulate an owner whose writer lock becomes available only after the
		// absolute deadline. It must refuse before touching the native pipe.
		time.Sleep(time.Until(time.UnixMilli(request.Deadline)) + 20*time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(409)
		json.NewEncoder(w).Encode(map[string]any{"message_id": request.MessageID, "error": map[string]string{"code": "native_boundary_changed"}})
	})}
	go server.Serve(listener)
	defer server.Close()
	b.activityHook(httptest.NewRecorder(), []byte(`{"native_session_id":"native","event":"Stop"}`))
	done := make(chan *httptest.ResponseRecorder, 1)
	start := time.Now()
	go func() {
		out := httptest.NewRecorder()
		b.channelDeliver(out, httptest.NewRequest("POST", "/receiver/channel-deliver", nil), []byte(`{"native_session_id":"native","message_id":"id","content":"message","delivery_timing":"after_turn"}`))
		done <- out
	}()
	var deadline int64
	select {
	case deadline = <-entered:
	case <-time.After(time.Second):
		t.Fatal("no callback")
	}
	delta := time.UnixMilli(deadline).Sub(start)
	if delta < 200*time.Millisecond || delta > 350*time.Millisecond {
		t.Fatalf("write budget=%v", delta)
	}
	hookDone := make(chan struct{})
	go func() {
		b.activityHook(httptest.NewRecorder(), []byte(`{"native_session_id":"native","event":"UserPromptSubmit"}`))
		close(hookDone)
	}()
	select {
	case <-hookDone:
		t.Fatal("prompt escaped guard before known prewrite result")
	case <-time.After(20 * time.Millisecond):
	}
	out := <-done
	if out.Code != 409 {
		t.Fatalf("%d %s", out.Code, out.Body.String())
	}
	<-hookDone
}

func TestClaudeChannelOnlyCorrelatedPrewrite409IsRetryable(t *testing.T) {
	for _, response := range []string{`{"message_id":"other","error":{"code":"native_boundary_changed"}}`, `{"message_id":"id","error":{"code":"other"}}`, `ownership changed`} {
		t.Run(response, func(t *testing.T) {
			b := claudeTurnBrokerFixture(t)
			listener, err := net.Listen("unix", filepath.Join(b.dir, "receiver-owner.sock"))
			if err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int32
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(409)
				w.Write([]byte(response))
			})}
			go server.Serve(listener)
			defer server.Close()
			b.activityHook(httptest.NewRecorder(), []byte(`{"native_session_id":"native","event":"Stop"}`))
			out := httptest.NewRecorder()
			b.channelDeliver(out, httptest.NewRequest("POST", "/receiver/channel-deliver", nil), []byte(`{"native_session_id":"native","message_id":"id","content":"message","delivery_timing":"after_turn"}`))
			if out.Code != 502 || calls.Load() != 1 {
				t.Fatalf("%d calls=%d", out.Code, calls.Load())
			}
		})
	}
}

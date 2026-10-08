package agentbus

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestGrokAdmissionIsCorrelatedAndRejectsReplay(t *testing.T) {
	for _, tt := range []struct {
		raw  string
		want bool
	}{
		{`{"method":"_x.ai/queue/changed","params":{"sessionId":"s","entries":[{"id":"p"}]}}`, true},
		{`{"method":"_x.ai/queue/changed","params":{"sessionId":"s","runningPromptId":"p"}}`, true},
		{`{"method":"session/update","params":{"sessionId":"s","_meta":{"promptId":"p"}}}`, true},
		{`{"method":"session/update","params":{"sessionId":"s","_meta":{"promptId":"p","replay":true}}}`, false},
		{`{"method":"_x.ai/queue/changed","params":{"sessionId":"other","runningPromptId":"p"}}`, false},
		{`{"method":"_x.ai/queue/changed","params":{"sessionId":"s","entries":[{"id":"other"}]}}`, false},
		{`{"id":"prompt-rpc","result":{"stopReason":"end_turn"}}`, false},
	} {
		var event map[string]any
		if err := json.Unmarshal([]byte(tt.raw), &event); err != nil {
			t.Fatal(err)
		}
		if got := grokAdmission(event, "s", "p"); got != tt.want {
			t.Fatalf("admission(%s)=%v", tt.raw, got)
		}
	}
}

func TestGrokQueueStdioIdentityAndAdmission(t *testing.T) {
	for _, wrapped := range []bool{false, true} {
		name := "direct"
		if wrapped {
			name = "native-extension-result"
		}
		t.Run(name, func(t *testing.T) { testGrokQueueStdioIdentityAndAdmission(t, wrapped) })
	}
}

func testGrokQueueStdioIdentityAndAdmission(t *testing.T, wrapped bool) {
	socket := filepath.Join(t.TempDir(), "leader.sock")
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	done := make(chan error, 1)
	go func() {
		conn, err := l.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		q := &grokQueue{conn: conn}
		frame, err := q.read()
		if err != nil {
			done <- err
			return
		}
		if stringArg(frame, "mode") != "stdio" || stringArg(frame, "type") != "register" {
			done <- io.ErrUnexpectedEOF
			return
		}
		_ = q.write(map[string]any{"type": "registered", "ready": false})
		_ = q.write(map[string]any{"type": "leader_ready"})
		for i := 0; i < 3; i++ {
			frame, err = q.read()
			if err != nil {
				done <- err
				return
			}
			var request map[string]any
			_ = json.Unmarshal([]byte(stringArg(frame, "payload")), &request)
			params, _ := request["params"].(map[string]any)
			if i == 0 {
				if stringArg(request, "method") != "_x.ai/sessions/list" {
					done <- io.ErrUnexpectedEOF
					return
				}
				result := map[string]any{"sessions": []any{map[string]any{"sessionId": "s", "resident": true, "activity": "idle"}, map[string]any{"sessionId": "dormant", "resident": false, "activity": "dormant"}}}
				if wrapped {
					result = map[string]any{"result": result}
				}
				raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": result})
				_ = q.write(map[string]any{"type": "acp", "payload": string(raw)})
			} else if i == 2 {
				if stringArg(request, "method") != "_x.ai/session/rename" || stringArg(params, "sessionId") != "s" || stringArg(params, "title") != "(Claudia) Review" {
					done <- io.ErrUnexpectedEOF
					return
				}
				raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{}})
				_ = q.write(map[string]any{"type": "acp", "payload": string(raw)})
			} else {
				meta, _ := params["_meta"].(map[string]any)
				if stringArg(request, "method") != "session/prompt" || meta["sendNow"] != false || stringArg(meta, "promptId") != "p" {
					done <- io.ErrUnexpectedEOF
					return
				}
				// A reverse approval is ignored; only correlated admission unblocks.
				_ = q.write(map[string]any{"type": "acp", "payload": `{"jsonrpc":"2.0","id":"approval","method":"session/request_permission","params":{}}`})
				_ = q.write(map[string]any{"type": "acp", "payload": `{"jsonrpc":"2.0","method":"_x.ai/queue/changed","params":{"sessionId":"s","runningPromptId":"p"}}`})
			}
		}
		done <- nil
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	q, err := openGrokQueue(ctx, socket, "")
	if err != nil {
		t.Fatal(err)
	}
	defer q.close()
	if id, err := q.identity(); err != nil || id != "s" {
		t.Fatalf("identity=%q,%v", id, err)
	}
	if err := q.send("p", "untrusted message"); err != nil {
		t.Fatal(err)
	}
	if err := q.setSessionName("s", "(Claudia) Review"); err != nil {
		t.Fatal(err)
	}
	if err := q.setSessionName("other", "Wrong"); err == nil {
		t.Fatal("renamed a foreign session")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestGrokQueueRejectsOversizedFrameAndMissingSocket(t *testing.T) {
	if _, err := openGrokQueue(context.Background(), "", ""); err == nil {
		t.Fatal("missing private socket accepted")
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	go func() {
		var header [4]byte
		binary.BigEndian.PutUint32(header[:], grokFrameLimit+1)
		_, _ = b.Write(header[:])
	}()
	if _, err := (&grokQueue{conn: a}).read(); err == nil {
		t.Fatal("oversized frame accepted")
	}
}

func TestGrokWorkerArgsAndOutput(t *testing.T) {
	args := nativeArgs("grok", "uuid")
	if !hasExact(args, "--no-leader") || !hasExact(args, "--resume") || hasExact(args, "-p") {
		t.Fatalf("unsafe Grok arguments %v", args)
	}
	reply, id := parseNativeOutput("grok", []byte(`{"text":"Done","stopReason":"end_turn","sessionId":"uuid"}`))
	if reply != "Done" || id != "uuid" {
		t.Fatalf("result %q %q", reply, id)
	}
	if reply, _ := parseNativeOutput("grok", []byte(`{"type":"error","text":"failure"}`)); reply != "" {
		t.Fatal("error rendered as reply")
	}
}
func hasExact(args []string, value string) bool {
	for _, arg := range args {
		if arg == value {
			return true
		}
	}
	return false
}

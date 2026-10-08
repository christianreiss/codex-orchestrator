package agentbus

import (
	"context"
	"golang.org/x/net/websocket"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestNativeQueueUsesWebSocketAndExistingThread(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "native.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	methods := []string{}
	server := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		for {
			var request struct {
				ID     int            `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if err := websocket.JSON.Receive(ws, &request); err != nil {
				return
			}
			mu.Lock()
			methods = append(methods, request.Method)
			mu.Unlock()
			if request.Method == "initialized" {
				continue
			}
			result := map[string]any{}
			switch request.Method {
			case "initialize":
			case "thread/loaded/list":
				result["data"] = []string{"native-thread"}
			case "thread/read":
				result["thread"] = map[string]any{"id": "native-thread", "source": "cli", "status": map[string]any{"type": "idle"}}
			case "thread/queue/add":
				if request.Params["threadId"] != "native-thread" || request.Params["clientUserMessageId"] != "delivery" {
					t.Error("delivery lost identity")
				}
				result["queuedSubmission"] = map[string]any{"id": "queued", "clientUserMessageId": "delivery"}
			default:
				t.Errorf("unexpected native method %s", request.Method)
			}
			// Interleaved notifications must not be mistaken for an RPC response.
			_ = websocket.JSON.Send(ws, map[string]any{"method": "thread/status/changed", "params": map[string]any{}})
			// RequestId is string or integer. Reverse approval requests belong to
			// the TUI and must not break decoding or be answered by this adapter.
			_ = websocket.JSON.Send(ws, map[string]any{"id": "native-approval", "method": "item/commandExecution/requestApproval", "params": map[string]any{}})
			_ = websocket.JSON.Send(ws, map[string]any{"id": "unrelated-response", "result": map[string]any{}})
			if err := websocket.JSON.Send(ws, map[string]any{"id": request.ID, "result": result}); err != nil {
				return
			}
		}
	})}
	go server.Serve(listener)
	defer server.Close()
	q, err := openNativeQueue(context.Background(), socket)
	if err != nil {
		t.Fatal(err)
	}
	defer q.close()
	if id, err := q.identity(); err != nil || id != "native-thread" {
		t.Fatalf("identity=%q err=%v", id, err)
	}
	if err := q.send("delivery", "test input"); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, method := range methods {
		if method == "thread/start" || method == "thread/resume" || method == "turn/steer" || method == "thread/queue/start" {
			t.Fatalf("created a second writer: %s", method)
		}
	}
}

func TestNativeQueueRejectsMissingAdmissionReceipt(t *testing.T) {
	if err := (&nativeQueue{}).send("delivery", "input"); err == nil {
		t.Fatal("unbound thread accepted a delivery")
	}
	socket := filepath.Join(t.TempDir(), "native.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		for {
			var req struct {
				ID     int    `json:"id"`
				Method string `json:"method"`
			}
			if websocket.JSON.Receive(ws, &req) != nil {
				return
			}
			if req.Method == "initialized" {
				continue
			}
			if websocket.JSON.Send(ws, map[string]any{"id": req.ID, "result": map[string]any{}}) != nil {
				return
			}
		}
	})}
	go server.Serve(listener)
	defer server.Close()
	q, err := openNativeQueue(context.Background(), socket)
	if err != nil {
		t.Fatal(err)
	}
	defer q.close()
	q.thread = "native"
	if err := q.send("delivery", "input"); err == nil {
		t.Fatal("RPC success without a queue receipt accepted as admission")
	}
}

func TestNativeWatchdogClassifiesFreshTurnsAndPreservesResetHints(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "native.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	reset := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	server := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		reads := 0
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
			result := map[string]any{}
			if req.Method == "thread/read" {
				reads++
				if req.Params["includeTurns"] != true || req.Params["threadId"] != "native" {
					t.Error("wrong native observation")
				}
				turn := map[string]any{"id": "capacity", "status": "failed", "error": map[string]any{"message": "Model at capacity", "reset_at": reset}}
				if reads == 3 {
					turn = map[string]any{"id": "auth", "status": "failed", "error": map[string]any{"message": "authentication failed"}}
				}
				if reads == 4 {
					turn = map[string]any{"id": "stop", "status": "interrupted"}
				}
				result["thread"] = map[string]any{"turns": []any{turn}}
			}
			if websocket.JSON.Send(ws, map[string]any{"id": req.ID, "result": result}) != nil {
				return
			}
		}
	})}
	go server.Serve(listener)
	defer server.Close()
	q, err := openNativeQueue(context.Background(), socket)
	if err != nil {
		t.Fatal(err)
	}
	defer q.close()
	q.thread = "native"
	for i, want := range []string{"capacity", "", "blocked", "user_stop"} {
		f, hint, err := q.watchdogFailure()
		if err != nil || f != want {
			t.Fatal(i, f, err)
		}
		if i == 0 && hint != reset {
			t.Fatal("provider reset lost", hint)
		}
	}
}

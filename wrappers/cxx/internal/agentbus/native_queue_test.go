package agentbus

import (
	"context"
	"golang.org/x/net/websocket"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
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
				result["queuedSubmission"] = map[string]any{"id": "queued"}
			default:
				t.Errorf("unexpected native method %s", request.Method)
			}
			// Interleaved notifications must not be mistaken for an RPC response.
			_ = websocket.JSON.Send(ws, map[string]any{"method": "thread/status/changed", "params": map[string]any{}})
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

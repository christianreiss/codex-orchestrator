package agentbus

import (
	"context"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"golang.org/x/net/websocket"
)

// Regression for feedback df5c9be9 (2026-10-14): an idle managed Codex session
// did not act on a peer message until the operator typed. Every queue admission
// first read the newest turn with thread/read includeTurns, which returns the
// whole rollout. Against Codex 0.163 a 118-turn session answered with an 8.6 MB
// frame, past the adapter's 8 MiB limit, and a fresh thread with no turn yet
// answered -32601. Either way send failed, the claimed message ended
// native_submission_uncertain, and the receiver reconnected without ever
// submitting it.

type nativeAnswer struct {
	result map[string]any
	err    map[string]any
	raw    string // pre-encoded result, for frames too large to build as maps
}

func fakeCodexAppServer(t *testing.T, answer func(method string, params map[string]any) nativeAnswer) (string, func() []string) {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "native.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var methods []string
	server := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
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
			mu.Lock()
			methods = append(methods, req.Method)
			mu.Unlock()
			a := nativeAnswer{result: map[string]any{}}
			if req.Method != "initialize" {
				a = answer(req.Method, req.Params)
			}
			var sendErr error
			switch {
			case a.raw != "":
				sendErr = websocket.Message.Send(ws, `{"id":`+strconv.Itoa(req.ID)+`,"result":`+a.raw+`}`)
			case a.err != nil:
				sendErr = websocket.JSON.Send(ws, map[string]any{"id": req.ID, "error": a.err})
			default:
				if a.result == nil {
					a.result = map[string]any{}
				}
				sendErr = websocket.JSON.Send(ws, map[string]any{"id": req.ID, "result": a.result})
			}
			if sendErr != nil {
				return
			}
		}
	})}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	return socket, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), methods...)
	}
}

func admitted(params map[string]any) nativeAnswer {
	return nativeAnswer{result: map[string]any{"queuedSubmission": map[string]any{"id": "queued", "clientUserMessageId": params["clientUserMessageId"]}}}
}

func TestNativeQueueAdmitsDeliveryToLongHistory(t *testing.T) {
	// 9 MiB of hydrated history: what the full read returns for a long session.
	history := `{"thread":{"turns":[{"id":"old","status":"completed","items":[{"type":"agentMessage","text":"` + strings.Repeat("x", 9<<20) + `"}]}]}}`
	socket, methods := fakeCodexAppServer(t, func(method string, params map[string]any) nativeAnswer {
		switch method {
		case "thread/read":
			if params["includeTurns"] == true {
				return nativeAnswer{raw: history}
			}
		case "thread/turns/list":
			return nativeAnswer{result: map[string]any{"data": []any{map[string]any{"id": "old", "status": "completed", "items": []any{}, "error": nil}}}}
		case "thread/queue/add":
			return admitted(params)
		}
		return nativeAnswer{}
	})
	q, err := openNativeQueue(context.Background(), socket)
	if err != nil {
		t.Fatal(err)
	}
	defer q.close()
	q.thread = "native"
	if err := q.send("delivery", "peer message"); err != nil {
		t.Fatalf("long-history session refused the delivery: %v", err)
	}
	for _, m := range methods() {
		if m == "thread/read" {
			t.Fatal("admission still hydrates the full rollout")
		}
	}
}

func TestNativeQueueAdmitsFirstDeliveryToFreshThread(t *testing.T) {
	for _, notYet := range []map[string]any{
		{"code": -32601, "message": "list_turns is not supported yet"},
		// Observed on native Codex 0.163.0 before the first user message.
		{"code": -32600, "message": "thread native is not materialized yet; thread/turns/list is unavailable before first user message"},
	} {
		t.Run(notYet["message"].(string), func(t *testing.T) { admitsFirstDeliveryToFreshThread(t, notYet) })
	}
}

func admitsFirstDeliveryToFreshThread(t *testing.T, notYet map[string]any) {
	t.Helper()
	socket, _ := fakeCodexAppServer(t, func(method string, params map[string]any) nativeAnswer {
		switch method {
		case "thread/turns/list", "thread/read":
			return nativeAnswer{err: notYet}
		case "thread/queue/add":
			return admitted(params)
		}
		return nativeAnswer{}
	})
	q, err := openNativeQueue(context.Background(), socket)
	if err != nil {
		t.Fatal(err)
	}
	defer q.close()
	q.thread = "native"
	if err := q.send("delivery", "first peer message"); err != nil {
		t.Fatalf("fresh idle session refused its first delivery: %v", err)
	}
	if failure, _, err := q.watchdogFailure(); failure != "" || err != nil {
		t.Fatalf("empty history reported %q %v", failure, err)
	}
}

func TestNativeQueueFallsBackWithoutTurnsList(t *testing.T) {
	// Codex 0.163 rejects an unknown method as a -32600 "unknown variant"; a
	// plain JSON-RPC -32601 "Method not found" must not pass for an empty history.
	for _, missing := range []map[string]any{
		{"code": -32600, "message": "Invalid request: unknown variant `thread/turns/list`, expected one of `initialize`"},
		{"code": -32601, "message": "Method not found"},
	} {
		t.Run(missing["message"].(string), func(t *testing.T) { fallsBackWithoutTurnsList(t, missing) })
	}
}

func fallsBackWithoutTurnsList(t *testing.T, missing map[string]any) {
	socket, _ := fakeCodexAppServer(t, func(method string, params map[string]any) nativeAnswer {
		switch method {
		case "thread/turns/list":
			return nativeAnswer{err: missing}
		case "thread/read":
			if params["includeTurns"] != true {
				t.Error("fallback lost the turn read")
			}
			return nativeAnswer{result: map[string]any{"thread": map[string]any{"turns": []any{
				map[string]any{"id": "first", "status": "completed"},
				map[string]any{"id": "last", "status": "failed", "error": map[string]any{"message": "native crash"}},
			}}}}
		}
		return nativeAnswer{}
	})
	q, err := openNativeQueue(context.Background(), socket)
	if err != nil {
		t.Fatal(err)
	}
	defer q.close()
	q.thread = "native"
	if failure, _, err := q.watchdogFailure(); failure != "crash" || err != nil {
		t.Fatalf("older Codex lost failure observation: %q %v", failure, err)
	}
}

func TestNativeQueueStillFailsClosedOnOtherReadErrors(t *testing.T) {
	for _, failure := range []map[string]any{
		{"code": -32600, "message": "thread not loaded: native"},
		{"code": -32600, "message": "thread foreign is not materialized yet; thread/turns/list is unavailable before first user message"},
		{"code": -32600, "message": "thread native is not materialized yet"},
		{"code": -32603, "message": "thread native is not materialized yet; thread/turns/list is unavailable before first user message"},
	} {
		t.Run(failure["message"].(string), func(t *testing.T) { failsClosedOnNativeReadError(t, failure) })
	}
}

func failsClosedOnNativeReadError(t *testing.T, failure map[string]any) {
	t.Helper()
	socket, methods := fakeCodexAppServer(t, func(method string, params map[string]any) nativeAnswer {
		if method == "thread/turns/list" {
			return nativeAnswer{err: failure}
		}
		if method == "thread/queue/add" {
			return admitted(params)
		}
		return nativeAnswer{}
	})
	q, err := openNativeQueue(context.Background(), socket)
	if err != nil {
		t.Fatal(err)
	}
	defer q.close()
	q.thread = "native"
	err = q.send("delivery", "peer message")
	if err == nil {
		t.Fatal("an unreadable thread admitted a delivery")
	}
	if strings.Contains(err.Error(), "thread not loaded") {
		t.Fatalf("native error message leaked into the receiver error: %v", err)
	}
	for _, m := range methods() {
		if m == "thread/queue/add" {
			t.Fatal("queued after a failed observation")
		}
	}
}

package communicator

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func TestDaemonCannotReattachBeforePreviousDisconnect(t *testing.T) {
	var disconnects atomic.Int32
	c := testConnection(t, func(ws *websocket.Conn, f frame) {
		if f.Type == "daemon_disconnect" {
			disconnects.Add(1)
		}
		if f.Type == "daemon" {
			_ = websocket.JSON.Send(ws, frame{Type: "daemon_event", Payload: f.Payload})
		}
		if f.Type == "request" {
			_ = websocket.JSON.Send(ws, frame{ID: f.ID, Status: 200})
		}
	})
	s := &server{conn: c}
	local := httptest.NewServer(s)
	defer local.Close()
	address := strings.Replace(local.URL, "http://", "ws://", 1) + "/_comm/daemon"
	first, err := websocket.Dial(address, "", local.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	deadline := time.Now().Add(time.Second)
	var previous chan json.RawMessage
	for previous == nil {
		c.mu.Lock()
		previous = c.daemon
		c.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatal("first daemon not attached")
		}
		time.Sleep(time.Millisecond)
	}
	// Hold the control writer so the old handler cannot send its disconnect.
	// Overflow closes its local socket, giving a new client a chance to attach.
	c.sendMu.Lock()
	locked := true
	defer func() {
		if locked {
			c.sendMu.Unlock()
		}
	}()
	c.detachDaemon(previous)
	first.SetReadDeadline(time.Now().Add(time.Second))
	var body string
	if websocket.Message.Receive(first, &body) == nil {
		t.Fatal("old daemon did not close")
	}
	second, err := websocket.Dial(address, "", local.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	second.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if err := websocket.Message.Receive(second, &body); err == nil || strings.Contains(err.Error(), "timeout") {
		t.Fatal("new daemon admitted while the previous disconnect is still pending", err)
	}
	c.mu.Lock()
	attached := c.daemon
	c.mu.Unlock()
	if attached != nil {
		t.Fatal("new daemon would be detached by previous cleanup")
	}
	c.sendMu.Unlock()
	locked = false
	deadline = time.Now().Add(time.Second)
	for {
		c.mu.Lock()
		closing := c.daemonClosing != nil
		c.mu.Unlock()
		if !closing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("disconnect did not release daemon admission")
		}
		time.Sleep(time.Millisecond)
	}
	third, err := websocket.Dial(address, "", local.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close()
	third.SetDeadline(time.Now().Add(time.Second))
	if err := websocket.Message.Send(third, `{"id":"replacement"}`); err != nil {
		t.Fatal(err)
	}
	if err := websocket.Message.Receive(third, &body); err != nil || body != `{"id":"replacement"}` {
		t.Fatal("replacement daemon failed", body, err)
	}
	// A duplicated stale cleanup must not send another remote disconnect.
	c.finishDaemon(previous)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := c.request(ctx, frame{Method: "GET", Path: "/barrier"}); err != nil {
		t.Fatal(err)
	}
	if disconnects.Load() != 1 {
		t.Fatal("stale cleanup disconnected the replacement", disconnects.Load())
	}
}

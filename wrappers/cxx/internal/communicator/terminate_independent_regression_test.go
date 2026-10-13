package communicator

import (
	"encoding/json"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

// Hold only this fixture's sender mutex. A blocked ACK must not postpone the
// owner's bounded shutdown, and must never monopolize the receiver loop.
func TestIndependentTerminateBoundIncludesBlockedAckWriter(t *testing.T) {
	c := testConnection(t, func(*websocket.Conn, frame) {})
	stopped := make(chan struct{}, 1)
	s := &server{stop: func() { stopped <- struct{}{} }, calls: map[string]*sharedCall{}}
	c.onTerminate = s.terminate
	c.sendMu.Lock()
	done := make(chan struct{})
	go func() {
		c.handleTerminate(frame{Type: "terminate", RequestID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Reason: "admin", OwnerInstanceID: processInstance})
		close(done)
	}()
	defer func() {
		c.sendMu.Unlock()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("fixture terminate handler did not finish after writer release")
		}
	}()
	select {
	case <-stopped:
	case <-time.After(3300 * time.Millisecond):
		t.Fatal("shutdown never started within the 3s bound while ACK writer was blocked")
	}
}

// A delayed command for another process must be rejected even if it arrives on
// this owner's current socket. request_id identifies the operation, not owner.
func TestIndependentTerminateRejectsAnotherOwnerIdentity(t *testing.T) {
	c := testConnection(t, func(*websocket.Conn, frame) {})
	stopped := make(chan struct{}, 1)
	c.onTerminate = func(string, <-chan struct{}) { stopped <- struct{}{} }
	var command frame
	if err := json.Unmarshal([]byte(`{"type":"terminate","request_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","owner_instance_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","reason":"admin"}`), &command); err != nil {
		t.Fatal(err)
	}
	c.handleTerminate(command)
	select {
	case <-stopped:
		t.Fatal("owner acted on a terminate command addressed to another owner_instance_id")
	default:
	}
}

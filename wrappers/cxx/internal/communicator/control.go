package communicator

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

// Remote control of the owner process by the server it is connected to.
//
// It is negotiated rather than assumed, so old servers and old owners are never
// confronted with a frame they do not know:
//
//  1. a server that can terminate an owner lists "terminate" in `ready.control`;
//  2. only then does the owner describe itself once, with a `capabilities`
//     frame (pid, start time, a per-process `instance_id` and its `runtime_id`,
//     which let the server tell a restarted owner from the one it asked to stop);
//  3. only then does the owner honour a `terminate` frame, and only one that
//     names this process (`owner_instance_id`), answering with `terminate_ack`.
//
// An owner that never saw step 1 ignores `terminate`, and a server never hears
// from an owner that did not see its announcement.
const controlTerminate = "terminate"

// terminateDrain bounds how long a terminating owner keeps serving local
// requests that are already in flight before it exits regardless. After the
// bound the remaining callers see what they would see if the owner crashed:
// a lost connection, which the managed adapters report as an unknown outcome
// and never replay.
var terminateDrain = 3 * time.Second

var processStarted = time.Now().UTC()

// processInstance names this owner process for as long as it runs. The server
// uses it to tell "the same owner dialled again" from "another owner".
var processInstance = uuid.NewString()

// runtimeIdentity names the local namespace an owner serves: the hash of its
// Unix socket path. Every owner that answers the same local clients has the same
// one (a replacement started after this one stops included), while owners in
// separate runtime roots, which may run side by side for one user, differ.
func runtimeIdentity(socket string) string {
	sum := sha256.Sum256([]byte(socket))
	return hex.EncodeToString(sum[:8])
}

func announces(control []string, name string) bool {
	for _, c := range control {
		if c == name {
			return true
		}
	}
	return false
}

// ackWriteBound bounds writing an acknowledgement: an owner that has accepted a
// stop must not stay up because the server stopped reading.
var ackWriteBound = 2 * time.Second

// announceCapabilities tells the server what this owner can be asked to do.
func (c *connection) announceCapabilities() {
	_ = c.send(map[string]any{
		"type":        "capabilities",
		"terminate":   c.onTerminate != nil,
		"pid":         os.Getpid(),
		"started_at":  processStarted.Format(time.RFC3339),
		"instance_id": processInstance,
		"runtime_id":  c.runtimeID,
	})
}

// sendWithin writes one frame, giving up after bound whether the write is slow or
// the writer lock is held by a send that is.
func (c *connection) sendWithin(value any, bound time.Duration) error {
	done := make(chan error, 1)
	go func() {
		c.sendMu.Lock()
		defer c.sendMu.Unlock()
		c.ws.SetWriteDeadline(time.Now().Add(bound))
		done <- websocket.JSON.Send(c.ws, value)
	}()
	select {
	case err := <-done:
		return err
	case <-time.After(bound):
		return errors.New("communicator: acknowledgement not written in time")
	}
}

// handleTerminate answers a server-requested exit and starts it. A command is
// honoured only when it names THIS process (`owner_instance_id`), so one aimed at
// an owner that has since been replaced, or that arrives on a socket that now
// belongs to another process, stops nothing. The reply echoes the request and the
// owner's identity. A repeated request id is answered again and stops nothing a
// second time. The stop begins without waiting for the reply to be written: the
// reply is bounded, and so is everything after it.
func (c *connection) handleTerminate(f frame) {
	reply := func(accepted bool, reason string) {
		_ = c.sendWithin(map[string]any{
			"type": "terminate_ack", "request_id": f.RequestID, "instance_id": processInstance,
			"accepted": accepted, "reason": reason, "pid": os.Getpid(),
		}, ackWriteBound)
	}
	if f.OwnerInstanceID != processInstance {
		reply(false, "owner_mismatch")
		return
	}
	if c.onTerminate == nil {
		reply(false, "unsupported")
		return
	}
	c.mu.Lock()
	first := !c.terminateSeen[f.RequestID]
	if c.terminateSeen == nil {
		c.terminateSeen = map[string]bool{}
	}
	c.terminateSeen[f.RequestID] = true
	c.mu.Unlock()
	acked := make(chan struct{})
	go func() {
		defer close(acked)
		reply(true, "")
	}()
	if first {
		c.onTerminate(f.Reason, acked)
	}
}

// terminate ends the owner the way an idle exit does (cancelling its context
// closes the HTTP server, the lock and the socket). From the moment it is
// accepted no new application work is admitted; work already in flight gets up
// to terminateDrain to finish, leases and streams are not waited for, and the
// acknowledgement gets only what remains of that bound to leave. Native sessions
// are not signalled; a surviving client starts a fresh owner on its next managed
// call.
func (s *server) terminate(reason string, acked <-chan struct{}) {
	if s.stop == nil || !s.terminating.CompareAndSwap(false, true) {
		return
	}
	s.draining.Store(true)
	go func() {
		deadline := time.Now().Add(terminateDrain)
		for time.Now().Before(deadline) {
			s.mu.Lock()
			quiet := s.active == 0 && len(s.calls) == 0
			s.mu.Unlock()
			if quiet {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		if acked != nil {
			wait := time.Until(deadline)
			if wait < 200*time.Millisecond {
				wait = 200 * time.Millisecond
			}
			select {
			case <-acked:
			case <-time.After(wait):
			}
		}
		fmt.Fprintf(os.Stderr, "communicator: stopping at the server's request (%s)\n", reason)
		s.stop()
	}()
}

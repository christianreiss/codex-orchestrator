package communicator

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"
)

// Remote control of the owner process by the server it is connected to.
//
// It is negotiated rather than assumed, so old servers and old owners are never
// confronted with a frame they do not know:
//
//  1. a server that can terminate an owner lists "terminate" in `ready.control`;
//  2. only then does the owner describe itself once, with a `capabilities`
//     frame (its pid and start time, which let the server tell a restarted owner
//     from the one it asked to stop);
//  3. only then does the owner honour a `terminate` frame, answering with
//     `terminate_ack` before it acts.
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

// handleTerminate acknowledges and then performs a server-requested exit. The
// acknowledgement is the owner's own statement that it will stop; whether the
// process is gone is something the server learns when the socket closes.
func (c *connection) handleTerminate(f frame) {
	if c.onTerminate == nil {
		_ = c.send(map[string]any{"type": "terminate_ack", "request_id": f.RequestID, "accepted": false, "reason": "unsupported"})
		return
	}
	_ = c.send(map[string]any{"type": "terminate_ack", "request_id": f.RequestID, "accepted": true, "pid": os.Getpid()})
	c.onTerminate(f.Reason)
}

// terminate ends the owner the way an idle exit does (cancelling its context
// closes the HTTP server, the lock and the socket), after letting in-flight
// local requests finish for a bounded time. Native sessions are not signalled; a
// surviving client restarts a fresh owner on its next managed call.
func (s *server) terminate(reason string) {
	if s.stop == nil || !s.terminating.CompareAndSwap(false, true) {
		return
	}
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
		fmt.Fprintf(os.Stderr, "communicator: stopping at the server's request (%s)\n", reason)
		s.stop()
	}()
}

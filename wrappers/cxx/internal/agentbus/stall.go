package agentbus

import (
	"context"
	"fmt"
	"regexp"
	"sync"
	"time"
)

// A model that yields its turn has no clock. Once both ends of a #call have
// yielded, a wake-up that never lands (the peer's receiver is down, or claimed a
// message it never surfaced) leaves both sides waiting on each other forever and
// nothing on the server notices. This MCP process outlives the turn and already
// owns an injection path into its own session, so it is the one place a clock
// can live: it watches for the reply to a message it sent and, if none arrives,
// tells its own model -- once or twice, never in a loop -- to stop waiting.

// stallAfter is how long a call message may go unanswered before its sender is
// told. A variable, not a constant, so tests need not sleep for it.
var stallAfter = 90 * time.Second

// stallMaxNotes bounds the notes per conversation. A model that is told the peer
// is silent and still keeps waiting gets one more reminder, then is left alone.
const stallMaxNotes = 2

// callAwaitsReply matches the CALL/1 verbs whose sender is now waiting on the
// peer. WAIT/HOLD/BYE-ACK/FIN are deliberately absent: a HOLD or a WAIT is
// answered late by design, and BYE-ACK/FIN end the conversation, so a nudge for
// them would be noise. A message that is not CALL/1 at all carries no promise of
// an answer, so it is never watched.
var callAwaitsReply = regexp.MustCompile(`^CALL/1 (HELLO-ACK|HELLO|SAY|ASK|BYE)(?:[ \t]|$)`)

// awaitedVerb returns the CALL/1 verb on the first line of content when the
// sender should expect an answer.
func awaitedVerb(content string) (string, bool) {
	line := content
	for i := 0; i < len(content); i++ {
		if content[i] == '\n' || content[i] == '\r' {
			line = content[:i]
			break
		}
	}
	match := callAwaitsReply.FindStringSubmatch(line)
	if match == nil {
		return "", false
	}
	return match[1], true
}

type stallWatch struct {
	messageID string
	verb      string
	notes     int
	timer     *time.Timer
}

// stallWatcher tracks at most one outstanding message per conversation: a new
// send supersedes the previous one, because the peer answering the newer message
// implies it saw the older.
type stallWatcher struct {
	mu      sync.Mutex
	watches map[string]*stallWatch
}

func newStallWatcher() *stallWatcher {
	return &stallWatcher{watches: make(map[string]*stallWatch)}
}

// arm starts (or restarts) the watch for a conversation. fire runs on the timer
// goroutine with the message that stalled and how many notes preceded this one.
func (w *stallWatcher) arm(conversationID, messageID, verb string, fire func(conversationID, messageID, verb string, prior int)) {
	if w == nil || conversationID == "" || messageID == "" {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if previous := w.watches[conversationID]; previous != nil {
		previous.timer.Stop()
	}
	watch := &stallWatch{messageID: messageID, verb: verb}
	w.schedule(conversationID, watch, fire)
	w.watches[conversationID] = watch
}

// schedule must be called with w.mu held.
func (w *stallWatcher) schedule(conversationID string, watch *stallWatch, fire func(conversationID, messageID, verb string, prior int)) {
	watch.timer = time.AfterFunc(stallAfter, func() {
		w.mu.Lock()
		// Superseded or cancelled while the timer was in flight: say nothing.
		if w.watches[conversationID] != watch {
			w.mu.Unlock()
			return
		}
		prior := watch.notes
		watch.notes++
		last := watch.notes >= stallMaxNotes
		if last {
			delete(w.watches, conversationID)
		}
		w.mu.Unlock()
		fire(conversationID, watch.messageID, watch.verb, prior)
		if last {
			return
		}
		w.mu.Lock()
		// Re-arm only if nothing arrived (or was sent) while fire ran.
		if w.watches[conversationID] == watch {
			w.schedule(conversationID, watch, fire)
		}
		w.mu.Unlock()
	})
}

// cancel ends the watch for a conversation: a delivery arrived, the
// conversation was cancelled, or the process is going away.
func (w *stallWatcher) cancel(conversationID string) {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if watch := w.watches[conversationID]; watch != nil {
		watch.timer.Stop()
		delete(w.watches, conversationID)
	}
}

// stopAll ends every watch.
func (w *stallWatcher) stopAll() {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for id, watch := range w.watches {
		watch.timer.Stop()
		delete(w.watches, id)
	}
}

// stallNote is the text injected into the model's own session. It is written by
// this wrapper, not by a peer, and says so: the model must be able to tell a
// local notice from untrusted peer content.
func stallNote(conversationID, messageID, verb, status string, waited time.Duration) string {
	what := "the server reports that message as " + status
	switch status {
	case "queued":
		what = "the peer's receiver never claimed it (status queued), so it is most likely not running or not reachable"
	case "leased", "accepted":
		what = "the peer's receiver claimed it (status " + status + ") but has not answered, so it may be stuck or busy"
	case "completed":
		what = "the peer processed it (status completed) but has sent nothing back"
	case "expired", "dead", "ambiguous", "canceled":
		what = "delivery ended without an answer (status " + status + ")"
	}
	return fmt.Sprintf("cxx notice (written by your local wrapper, not by a peer): no reply to your CALL/1 %s "+
		"(message %s, conversation %s) after %d s; %s.\n"+
		"Tell the user the peer is not answering and stop waiting. Do not poll and do not resend. "+
		"Call agent_cancel on the conversation if you are giving up on the call.",
		verb, messageID, conversationID, int(waited.Seconds()), what)
}

// noteStalled builds and injects the notice for a message that went unanswered.
// A failed status lookup still produces a note: a control-plane outage is itself
// a reason not to wait silently.
func (r *autoReceiver) noteStalled(ctx context.Context, conversationID, messageID, verb string, prior int) {
	status := "unknown"
	var got struct {
		Message struct {
			Status string `json:"status"`
		} `json:"message"`
	}
	lookup, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := r.client.post(lookup, "message", map[string]any{"message_id": messageID}, &got); err == nil && got.Message.Status != "" {
		status = got.Message.Status
	}
	waited := stallAfter * time.Duration(prior+1)
	note := stallNote(conversationID, messageID, verb, status, waited)
	if prior > 0 {
		note = "(reminder) " + note
	}
	// deliver is the same injection path peer messages use; no tracker entry is
	// created, so the note can never hold the address's one delivery slot.
	// Native queue submissions are idempotent by clientUserMessageId. A reminder
	// is a new notice, so it needs its own ID rather than replaying the first one.
	_ = r.deliver(fmt.Sprintf("stall:%s:%d", messageID, prior), note)
}

// watchOutbound arms the dead-air watch for a message this process just sent, if
// its CALL/1 verb means an answer is due. No-op outside automatic mode: there the
// model stays inside agent_listen and the skill's own timers apply.
func (r *autoReceiver) watchOutbound(ctx context.Context, conversationID, messageID, content string) {
	if r == nil {
		return
	}
	verb, ok := awaitedVerb(content)
	if !ok {
		return
	}
	r.stall.arm(conversationID, messageID, verb, func(conversationID, messageID, verb string, prior int) {
		r.noteStalled(ctx, conversationID, messageID, verb, prior)
	})
}

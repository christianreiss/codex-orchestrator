package agentbus

// Turn-end release.
//
// The automatic Claude receiver claims only while it holds nothing, and the
// server leases one delivery per address. An informational delivery therefore
// stays held -- renewed every 20s, never expiring once accepted -- until the
// model answers it with agent_reply or calls agent_listen. A model that reads a
// message mid-work, reacts with agent_send to someone else and ends its turn
// leaves the session idle with reception closed: every later message, schedule
// wake included, queues behind it until a human types and the UserPromptSubmit
// ring finally shows "calls waiting". Seen live on biest on 2026-10-12, where 24
// of 117 Claude deliveries in one day waited more than ten minutes on an idle
// session.
//
// A finished turn is the model being done with everything it has seen, which is
// exactly what agent_listen asserts. So the Stop and UserPromptSubmit hooks
// complete held informational deliveries -- but only those the transcript shows
// were actually dequeued into the conversation. A channel notification that
// arrived in the turn's last moments sits in Claude Code's queue and starts the
// next turn; releasing it here would complete a message nobody read. Accepted
// work and an open Portal instruction are never released: they need an explicit
// result, so the hook rings once about them instead.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	ownerSocketName  = "receiver-owner.sock"
	ownerHeldPath    = "/turn/held"
	ownerReleasePath = "/turn/release"
	// A transcript line is one JSON entry; tool results can make one large, so
	// the reader is bounded per line rather than by a scanner token limit.
	maxTranscriptLine = 64 << 20
)

// heldDelivery is what the receiver owner reports holding at a turn boundary.
type heldDelivery struct {
	MessageID string `json:"message_id"`
	// Kind is "informational", "work" or "portal". Only informational ones are
	// ever released by a turn boundary.
	Kind   string `json:"kind"`
	Sender string `json:"sender,omitempty"`
}

type heldReport struct {
	Held                  []heldDelivery `json:"held"`
	ReceiverReady         bool           `json:"receiver_ready"`
	CoordinationReception bool           `json:"coordination_reception,omitempty"`
}

type releaseReport struct {
	Released []string `json:"released"`
	heldReport
}

func (t *channelTracker) heldReport() heldReport {
	report := heldReport{Held: []heldDelivery{}}
	if t == nil {
		return report
	}
	t.mu.Lock()
	for id, p := range t.items {
		kind := "informational"
		if p.workKind != "" {
			kind = "work"
		}
		report.Held = append(report.Held, heldDelivery{MessageID: id, Kind: kind, Sender: p.sender})
	}
	t.mu.Unlock()
	if r := t.receiver; r != nil {
		r.mu.Lock()
		if r.pendingPortal != nil {
			report.Held = append(report.Held, heldDelivery{MessageID: stringArg(r.pendingPortal, "message_id"), Kind: "portal"})
		}
		r.mu.Unlock()
		report.ReceiverReady = r.health()["state"] == "ready"
		report.CoordinationReception = r.coordinationEnabled()
	}
	return report
}

// releaseSeen completes the held informational deliveries named in seen, the
// same completion agent_listen performs. Work and Portal ownership stay put.
func (t *channelTracker) releaseSeen(ctx context.Context, seen []string) (releaseReport, error) {
	want := make(map[string]bool, len(seen))
	for _, id := range seen {
		want[id] = true
	}
	var released []string
	t.mu.Lock()
	candidates := make(map[string]*channelPending)
	for id, p := range t.items {
		if want[id] && p.workKind == "" && !p.admissionPending() {
			candidates[id] = p
		}
	}
	t.mu.Unlock()
	var firstErr error
	for id, p := range candidates {
		if err := t.completePending(ctx, id, p); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		released = append(released, id)
	}
	return releaseReport{Released: released, heldReport: t.heldReport()}, firstErr
}

func (o *receiverOwner) serveTurn(w http.ResponseWriter, r *http.Request, ctx context.Context) {
	var input struct {
		SessionID string   `json:"session_id"`
		Seen      []string `json:"seen"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil || input.SessionID != o.client.id {
		http.Error(w, "invalid receiver request", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == ownerHeldPath {
		_ = json.NewEncoder(w).Encode(o.tracker.heldReport())
		return
	}
	report, err := o.tracker.releaseSeen(ctx, input.Seen)
	if err != nil && len(report.Released) == 0 {
		http.Error(w, sanitizedError(err), http.StatusBadGateway)
		return
	}
	_ = json.NewEncoder(w).Encode(report)
}

// turnEnd is the hook's view after the release attempt.
type turnEnd struct {
	released      int
	stillHeld     []heldDelivery
	receiverReady bool
	// blocked is set while accepted work or a Portal instruction is still held.
	// Reception stays paused behind it, and agent_listen cannot change that.
	blocked bool
}

// releaseAtTurnEnd runs in the hook process. It asks the launch's receiver owner
// what it holds, checks the transcript for which of those were read, and has
// the owner release them. Any failure returns nil: the hook then behaves exactly
// as it did before this existed.
func releaseAtTurnEnd(transcriptPath string, timeout time.Duration) *turnEnd {
	socket := strings.TrimSpace(os.Getenv(envSocket))
	session := strings.TrimSpace(os.Getenv(envSessionID))
	if socket == "" || session == "" {
		return nil
	}
	owner := sessionClientAt(filepath.Join(filepath.Dir(socket), ownerSocketName), session, timeout)
	defer owner.http.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var held heldReport
	if err := ownerPost(ctx, owner, ownerHeldPath, nil, &held); err != nil {
		return nil
	}
	seen := seenInTranscript(transcriptPath, held.Held)
	var release []string
	for _, h := range held.Held {
		if h.Kind == "informational" && seen[h.MessageID] {
			release = append(release, h.MessageID)
		}
	}
	end := &turnEnd{receiverReady: held.ReceiverReady}
	coordination := held.CoordinationReception
	remaining := held.Held
	if len(release) > 0 {
		var out releaseReport
		if err := ownerPost(ctx, owner, ownerReleasePath, release, &out); err == nil {
			end.released = len(out.Released)
			end.receiverReady = out.ReceiverReady
			remaining = out.Held
			coordination = out.CoordinationReception
		}
	}
	// Only what the model has read can be rung about; an unread delivery is
	// still on its way into the conversation.
	for _, h := range remaining {
		if h.Kind == "work" && coordination && end.receiverReady {
			continue
		}
		if h.Kind == "work" || h.Kind == "portal" {
			end.blocked = true
		}
		if seen[h.MessageID] {
			end.stillHeld = append(end.stillHeld, h)
		}
	}
	return end
}

func ownerPost(ctx context.Context, owner *sessionClient, path string, seen []string, out any) error {
	body := map[string]any{"session_id": owner.id, "seen": seen}
	if seen == nil {
		body["seen"] = []string{}
	}
	return doJSON(ctx, owner.http, "http://receiver.local", http.MethodPost, path, body, nil, out)
}

// seenInTranscript reports which held message ids were dequeued into the
// conversation: a `user` entry whose text opens the receiver's channel tag for
// that id. Claude Code also logs a `queue-operation` entry when it merely
// queues a notification; that one does not count.
func seenInTranscript(path string, held []heldDelivery) map[string]bool {
	seen := map[string]bool{}
	if strings.TrimSpace(path) == "" || len(held) == 0 {
		return seen
	}
	needles := make(map[string][]byte, len(held))
	for _, h := range held {
		if h.MessageID != "" {
			needles[h.MessageID] = []byte(`message_id=\"` + h.MessageID + `\"`)
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return seen
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 1<<20)
	for len(seen) < len(needles) {
		line, err := readTranscriptLine(reader)
		if len(line) > 0 && (bytes.Contains(line, []byte("<channel ")) || bytes.Contains(line, []byte(`\u003cchannel `))) {
			for id, needle := range needles {
				if !seen[id] && bytes.Contains(line, needle) && channelEntryFor(line, id) {
					seen[id] = true
				}
			}
		}
		if err != nil {
			break
		}
	}
	return seen
}

func readTranscriptLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		if len(line)+len(chunk) <= maxTranscriptLine {
			line = append(line, chunk...)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return line, err
	}
}

func channelEntryFor(line []byte, id string) bool {
	var entry struct {
		Type    string `json:"type"`
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &entry) != nil || entry.Type != "user" {
		return false
	}
	tag := `message_id="` + id + `"`
	var text string
	if json.Unmarshal(entry.Message.Content, &text) == nil {
		return strings.HasPrefix(text, "<channel ") && strings.Contains(text, tag)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(entry.Message.Content, &blocks) != nil {
		return false
	}
	for _, block := range blocks {
		if block.Type == "text" && strings.HasPrefix(block.Text, "<channel ") && strings.Contains(block.Text, tag) {
			return true
		}
	}
	return false
}

// readHookInput takes the transcript path from a Claude Code hook payload.
// A missing or malformed payload is not an error: the hook still rings.
func readHookInput(stdin io.Reader) string {
	if stdin == nil {
		return ""
	}
	var input struct {
		TranscriptPath string `json:"transcript_path"`
	}
	if json.NewDecoder(io.LimitReader(stdin, 1<<20)).Decode(&input) != nil {
		return ""
	}
	return input.TranscriptPath
}

// heldSummary rings once per held item the model has read but not finished.
// Unlike informational mail, work and Portal instructions cannot be released by
// a turn boundary, and while one is held nothing else reaches this session.
func (l *ringLedger) heldSummary(event string, held []heldDelivery) string {
	var text strings.Builder
	for _, h := range held {
		if h.Kind != "work" && h.Kind != "portal" {
			continue
		}
		if !l.mark(event + " held " + h.MessageID) {
			continue
		}
		if text.Len() == 0 {
			text.WriteString("Agent-bus reception is paused behind something you have read but not finished:\n")
		}
		if h.Kind == "portal" {
			fmt.Fprintf(&text, "  - operator Portal message %s: answer with agent_receiver_reply\n", h.MessageID)
			continue
		}
		fmt.Fprintf(&text, "  - accepted work %s", h.MessageID)
		if h.Sender != "" {
			fmt.Fprintf(&text, " from %s", h.Sender)
		}
		text.WriteString(": report it with agent_task_result (or agent_reply with task_result)\n")
	}
	if text.Len() == 0 {
		return ""
	}
	text.WriteString("\nNo other message, wake or call can be delivered to this session until you do. If the work is genuinely still running, carry on; this will not ring again.\n")
	return text.String()
}

// nativeTurnSettle is how long a Codex or Grok thread must stay idle after a
// busy spell before its queue counts as drained. The native TUI starts a queued
// submission at its next safe boundary, so an idle thread that still had our
// message queued would turn busy again well within this window.
const nativeTurnSettle = 10 * time.Second

func (t *channelTracker) markNativeDelivered(p *channelPending, at time.Time) {
	t.mu.Lock()
	p.nativeAt = at
	t.mu.Unlock()
}

// releaseAfterNativeTurn is the Codex/Grok counterpart of the Claude Stop hook.
// Those adapters submit only while the thread is idle, so the next busy spell is
// the turn that consumes the delivery; once the thread has settled idle after
// it, the model has read the message and ended its turn. Held informational
// deliveries submitted before that spell are then released exactly as
// agent_listen would. Work and Portal ownership are untouched.
func (r *autoReceiver) releaseAfterNativeTurn(ctx context.Context, status string, now time.Time) {
	if status != "idle" {
		if r.turnBusyAt.IsZero() {
			r.turnBusyAt = now
		}
		r.turnIdleSince = time.Time{}
		return
	}
	if r.turnBusyAt.IsZero() {
		return
	}
	if r.turnIdleSince.IsZero() {
		r.turnIdleSince = now
		return
	}
	if now.Sub(r.turnIdleSince) < nativeTurnSettle {
		return
	}
	busyAt := r.turnBusyAt
	if err := r.tracker.releaseNativeTurn(ctx, busyAt); err != nil {
		return // keep the observation; the next tick retries
	}
	r.turnBusyAt, r.turnIdleSince = time.Time{}, time.Time{}
}

func (t *channelTracker) releaseNativeTurn(ctx context.Context, busyAt time.Time) error {
	t.mu.Lock()
	var seen []string
	for id, p := range t.items {
		if p.workKind == "" && !p.nativeAt.IsZero() && p.nativeAt.Before(busyAt) {
			seen = append(seen, id)
		}
	}
	t.mu.Unlock()
	if len(seen) == 0 {
		return nil
	}
	_, err := t.releaseSeen(ctx, seen)
	return err
}

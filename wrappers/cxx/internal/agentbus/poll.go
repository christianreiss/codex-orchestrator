package agentbus

// The ring.
//
// An interactive agent has no interrupt: it exists only during a turn. Between
// turns nothing of it is running, so a message addressed to an attached session
// sits queued until it expires and neither side ever learns a call was placed.
// The relay cannot help -- it deliberately skips any address whose wrapper is
// attached -- and the session itself only pulls when it calls `agent_listen`.
//
// `cxx agent poll` is what a Claude Code hook runs at a turn boundary, the only
// moment a notification can land, to turn that silence into a ring.
//
// Two rules hold this together and both are load-bearing:
//
//   - Polling never binds `receive_capable`. Binding is what `agent_listen`
//     does, and it flips the address to readiness "live" for every peer reading
//     `agent list`. A process that binds at every turn boundary but listens only
//     when told to would advertise itself as reachable while actually checking
//     mail twice a minute -- a worse lie than being unbound. Ringing and
//     answering stay separate: this reports, `agent_listen` collects.
//   - A Stop hook that blocks every time is a session that can never end its
//     turn, and Claude Code ships no `stop_hook_active` guard to catch that. So
//     each message rings at most once per event, recorded under the cache dir.
//     If that record cannot be written, this does not block. A ringer that
//     wedges a session is worse than one that misses a call.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/authnotice"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/contentnotice"
)

const (
	hookEventStop   = "Stop"
	hookEventPrompt = "UserPromptSubmit"
	// Enough history that a long session cannot ring the same call twice, small
	// enough that the file stays a cheap read at every turn boundary.
	ringLedgerLimit = 256
	ringLedgerTTL   = 24 * time.Hour
	// A run of Stop blocks closer together than this counts as one chain, and a
	// chain longer than maxStopChain stops blocking (feedback 43fe5d65).
	stopChainWindow = 5 * time.Minute
	maxStopChain    = 3
)

type mailboxPeer struct {
	Address string `json:"address"`
	Alias   string `json:"alias"`
	Engine  string `json:"engine"`
	FQDN    string `json:"fqdn"`
}

type mailboxEntry struct {
	MessageID      string `json:"message_id"`
	ConversationID string `json:"conversation_id"`
	Kind           string `json:"kind"`
	// DeliveryClass is absent from an older server; an entry without one is
	// treated as needing an answer, the ring's conservative default.
	DeliveryClass string      `json:"delivery_class"`
	From          mailboxPeer `json:"from"`
	ExpiresAt     string      `json:"expires_at"`
	ExpiredAt     string      `json:"expired_at"`
}

type mailbox struct {
	Pending []mailboxEntry `json:"pending"`
	Missed  []mailboxEntry `json:"missed"`
}

// needsAnswer reports whether a queued message is something a Stop block can be
// justified for. Presence notices, publications and digests are informational by
// definition (the server's own relay never treats them as urgent), and the
// progress and notice delivery classes say the sender expects no answer. The
// receiver still delivers all of them; they just never hold a turn open.
func (e mailboxEntry) needsAnswer() bool {
	switch e.Kind {
	case "presence_notice", "publication", "digest":
		return false
	}
	switch e.DeliveryClass {
	case "progress", "notice":
		return false
	}
	return true
}

// name is what a human should recognise: the alias if the fleet gave it one,
// otherwise the host it is calling from. The raw agent:<uuid> is a last resort.
func (p mailboxPeer) name() string {
	if alias := strings.TrimSpace(p.Alias); alias != "" {
		return alias
	}
	if fqdn := strings.TrimSpace(p.FQDN); fqdn != "" {
		return fqdn
	}
	return p.Address
}

func runPoll(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	flags := newFlagSet("cxx agent poll", stderr)
	hook := flags.String("hook", "", "emit Claude Code hook JSON for an event: Stop or UserPromptSubmit")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errorsUsage("cxx agent poll", "unexpected argument")
	}
	event := strings.TrimSpace(*hook)
	if event != "" && event != hookEventStop && event != hookEventPrompt {
		return errorsUsage("cxx agent poll", "--hook must be "+hookEventStop+" or "+hookEventPrompt)
	}

	if event != "" && ringHooksDisabled() {
		// Empty stdout with exit 0 is "no decision" for the native hook runner.
		return nil
	}
	if event == "" {
		box, err := peekMailbox(5 * time.Second)
		if err != nil {
			return err
		}
		return writeJSON(stdout, box)
	}
	// Release first, so the peek below already sees what the receiver will now
	// deliver on its own (see turn_release.go).
	end := releaseAtTurnEnd(readHookInput(stdin), 3*time.Second)
	box, err := peekMailbox(5 * time.Second)
	// Hook mode is silent on every failure. A host with messaging disabled, a
	// session outside a managed lifecycle, an orchestrator that is down -- none
	// of those are the user's problem mid-turn, and a hook that reports them
	// would put a wrapper diagnostic in front of unrelated work every time.
	if err != nil || box == nil {
		box = &mailbox{}
	}
	return emitHook(stdout, event, box, end)
}

func peekMailbox(timeout time.Duration) (*mailbox, error) {
	client, err := sessionClientFromEnv(timeout)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var box mailbox
	if err := client.post(ctx, "mailbox", map[string]any{}, &box); err != nil {
		return nil, err
	}
	return &box, nil
}

// ringHooksDisabled reports a lifecycle whose native turn boundaries this ring
// must not touch. The hooks are rendered for Claude only, but Grok's Claude
// compatibility layer imports ~/.claude/settings.json hooks on hosts that also
// run clx. There a blocking Stop keeps the Grok thread `working`, and the
// automatic Grok receiver claims only while the thread is idle: the ring itself
// held reception shut (claim_gate thread_working) and asked the model to call
// agent_listen, which cannot force a claim. The transcript check in
// releaseAtTurnEnd also only understands Claude's channel entries. Grok releases
// read informational deliveries on its own once the thread settles idle
// (releaseAfterNativeTurn), so the clean yield is what delivers the next body.
func ringHooksDisabled() bool {
	return strings.TrimSpace(os.Getenv("CXX_AGENT_PORTAL_ENGINE")) == "grok"
}

func emitHook(stdout io.Writer, event string, box *mailbox, end *turnEnd) error {
	if ringHooksDisabled() {
		return nil
	}
	if end.pushesPending(event) {
		// A healthy receiver will push what is pending into the conversation,
		// waking it if idle. Ringing it as well would send the model to
		// agent_listen, which releases that next message before it has been read,
		// or block a Stop the receiver is waiting for (see pushesPending).
		box = &mailbox{Missed: box.Missed}
	}
	if event == hookEventStop {
		box = answerable(box)
	}
	fresh, ledger := unrung(event, box)
	var heldText string
	if end != nil {
		heldText = ledger.heldSummary(event, end.stillHeld)
	}
	var authContext string
	var authDelivery *authnotice.Delivery
	if event == hookEventPrompt {
		if delivery, err := authnotice.Prepare("claude", os.Getenv(envSessionID)); err == nil && delivery != nil {
			authDelivery = delivery
			authContext = delivery.Notice.Message()
		}
	}
	defer authDelivery.Abort()
	var contentContext string
	var contentDelivery *contentnotice.Delivery
	if event == hookEventPrompt {
		if delivery, err := contentnotice.Prepare("claude", os.Getenv(envSessionID)); err == nil && delivery != nil {
			contentDelivery = delivery
			contentContext = delivery.Notice.Message()
		}
	}
	defer contentDelivery.Abort()
	if len(fresh) == 0 && authContext == "" && contentContext == "" && heldText == "" {
		return nil
	}
	summary := ringSummary(fresh, end.ringMode())
	if heldText != "" {
		if summary.context != "" {
			summary.context += "\n"
		}
		summary.context += heldText
		if summary.human == "" {
			summary.human = "☎ answer still owed on the agent bus"
		}
	}
	if authContext != "" {
		if summary.context != "" {
			summary.context += "\n\n"
		}
		if summary.human != "" {
			summary.human += "\n"
		}
		summary.context += authContext
		summary.human += "Claude credentials updated"
	}
	if contentContext != "" {
		if summary.context != "" {
			summary.context += "\n\n"
		}
		if summary.human != "" {
			summary.human += "\n"
		}
		summary.context += contentContext
		summary.human += "Fleet content updated"
	}
	// Only commit the ledger once the ring is certain to be emitted, so a write
	// that fails here cannot silently swallow a call. A Stop ring that could not
	// be recorded is dropped instead: it would block every later turn end too.
	if event == hookEventStop {
		// Distinct messages each ring once, so a conference whose peers answer in
		// quick succession would still block one turn end per peer. Past the chain
		// cap the Stop lets the turn end; the ring stays unrecorded for Stop, so
		// UserPromptSubmit still announces it.
		if ledger.stopChainFull(time.Now()) {
			return nil
		}
		ledger.recordStopBlock(time.Now())
	}
	if !ledger.commit() && event == hookEventStop {
		return nil
	}

	if event == hookEventPrompt {
		if err := writeJSON(stdout, map[string]any{
			"hookSpecificOutput": map[string]any{
				"hookEventName":     hookEventPrompt,
				"additionalContext": summary.context,
			},
			"systemMessage": summary.human,
		}); err != nil {
			return err
		}
		return errors.Join(authDelivery.Commit(), contentDelivery.Commit())
	}
	// Stop blocks, because that is the whole point: informing the agent after
	// the turn has already ended reaches nobody until the next prompt, which
	// UserPromptSubmit already covers. Blocking is safe only because each
	// message is rung once -- see the ledger above.
	return writeJSON(stdout, map[string]any{
		"decision":      "block",
		"reason":        summary.context,
		"systemMessage": summary.human,
	})
}

type ringText struct {
	// context is written to the agent; human is shown to the operator.
	context string
	human   string
}

// ringMode picks what a pending-mail ring tells the model to do.
type ringMode int

const (
	// ringListen: agent_listen claims (manual) or reopens reception (a read
	// delivery still held). Also the fallback when the owner is unknown or old.
	ringListen ringMode = iota
	// ringBlocked: this session still holds accepted work or a Portal
	// instruction. The pending messages then queue behind it, and the usual
	// advice to call agent_listen is wrong: listen cannot release work, and
	// telling a model it "releases anything you were holding" is how a
	// coordinator ended its own still-running request as unknown on 2026-10-14.
	ringBlocked
	// ringAfterTurn: a healthy turn-gated receiver pushes the messages once this
	// turn ends. agent_listen cannot fetch a body mid-turn; a coordinator that
	// was told to call it did so repeatedly and got nothing (feedback b0f9361b).
	ringAfterTurn
)

func (e *turnEnd) ringMode() ringMode {
	switch {
	case e == nil:
		return ringListen
	case e.blocked:
		return ringBlocked
	case e.receiverReady && e.afterTurn && len(e.stillHeld) == 0:
		return ringAfterTurn
	}
	return ringListen
}

func ringSummary(fresh []mailboxEntry, mode ringMode) ringText {
	var pending, missed []mailboxEntry
	for _, entry := range fresh {
		if entry.MessageID == "" {
			missed = append(missed, entry)
			continue
		}
		pending = append(pending, entry)
	}
	var agent, human strings.Builder
	if len(pending) > 0 {
		fmt.Fprintf(&agent, "You have %s waiting on the agent bus:\n", plural(len(pending), "message", "messages"))
		for _, entry := range pending {
			fmt.Fprintf(&agent, "  - from %s (%s)", entry.From.name(), entry.From.Engine)
			if window := expiryHint(entry.ExpiresAt); window != "" {
				fmt.Fprintf(&agent, ", expires %s", window)
			}
			agent.WriteString("\n")
		}
		switch mode {
		case ringBlocked:
			agent.WriteString(
				"\nThis is a ring, not the message. It is queued behind accepted work or an operator Portal " +
					"instruction you still hold, and arrives on its own once that is answered: report work with " +
					"`agent_task_result` (or `agent_reply` with task_result) and Portal instructions with " +
					"`agent_receiver_reply`, but only when they are actually finished. `agent_listen` does not release " +
					"them. If the work is still running, carry on; this will not ring again.\n")
		case ringAfterTurn:
			agent.WriteString(
				"\nThis is a ring, not the message. The automatic receiver pushes these into this conversation " +
					"after the current turn ends; only a message its sender marked `delivery_timing: \"immediate\"` " +
					"can arrive while you are working. `agent_listen` returns no message body, so calling it now " +
					"does not help. To read them sooner, finish your turn; otherwise carry on.\n")
		default:
			agent.WriteString(
				"\nThis is a ring, not the message: the body is only released when you collect it. " +
					"To answer, call `agent_listen` once: with the automatic receiver it releases the message " +
					"you were holding, and the next one is pushed into this conversation (after the current turn " +
					"ends when delivery is turn-gated); otherwise it claims the message and binds this session " +
					"receive-capable. Calling it repeatedly does not help. To decline, say so and carry on; " +
					"this message will not ring again.\n")
		}
		fmt.Fprintf(&human, "☎ %s waiting from %s", plural(len(pending), "call", "calls"), pending[0].From.name())
		if len(pending) > 1 {
			fmt.Fprintf(&human, " and %d more", len(pending)-1)
		}
		if mode == ringAfterTurn {
			human.WriteString(" (delivered after this turn)")
		}
	}
	if len(missed) > 0 {
		if agent.Len() > 0 {
			agent.WriteString("\n")
		}
		fmt.Fprintf(&agent, "You missed %s that expired unanswered:\n", plural(len(missed), "call", "calls"))
		for _, entry := range missed {
			fmt.Fprintf(&agent, "  - from %s at %s\n", entry.From.name(), entry.ExpiredAt)
		}
		agent.WriteString("\nNothing to answer; mention it so the operator knows a peer tried to reach this session.\n")
		if human.Len() == 0 {
			fmt.Fprintf(&human, "☎ missed %s from %s", plural(len(missed), "call", "calls"), missed[0].From.name())
		}
	}
	return ringText{context: agent.String(), human: human.String()}
}

// answerable drops the informational entries a Stop must never block for.
// Expired (missed) entries stay: they are a courtesy line, not a block reason on
// their own, and the ledger rings each one once.
func answerable(box *mailbox) *mailbox {
	out := &mailbox{Missed: box.Missed, Pending: make([]mailboxEntry, 0, len(box.Pending))}
	for _, entry := range box.Pending {
		if entry.needsAnswer() {
			out.Pending = append(out.Pending, entry)
		}
	}
	return out
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// expiryHint renders the answer window in whole minutes. The agent uses it to
// weigh answering now against finishing what it is doing, so a coarse number is
// the honest one -- the message may expire between this ring and the pickup.
func expiryHint(value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	deadline, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return ""
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return "now"
	}
	if remaining < time.Minute {
		return "in under a minute"
	}
	return fmt.Sprintf("in %dm", int(remaining.Minutes()))
}

// unrung filters the mailbox down to what this event has not already announced,
// and returns the ledger that will record them once the ring is emitted.
func unrung(event string, box *mailbox) ([]mailboxEntry, *ringLedger) {
	ledger := loadRingLedger()
	fresh := make([]mailboxEntry, 0, len(box.Pending)+len(box.Missed))
	for _, entry := range box.Pending {
		if ledger.mark(event + " " + entry.MessageID) {
			fresh = append(fresh, entry)
		}
	}
	for _, entry := range box.Missed {
		// Expired messages carry no id to key on -- the peek reports them as a
		// courtesy, not as work. Key on who called and when, which is stable.
		if ledger.mark(event + " missed " + entry.From.Address + " " + entry.ExpiredAt) {
			fresh = append(fresh, mailboxEntry{From: entry.From, ExpiredAt: entry.ExpiredAt})
		}
	}
	return fresh, ledger
}

// ringLedger remembers what has already rung, per session.
//
// A disabled ledger (unreadable cache dir, unknown session) marks nothing as
// fresh, which means no ring and therefore no Stop block. Failing closed is
// deliberate: a missed call is recoverable, a session that cannot end its turn
// is not.
type ringLedger struct {
	path    string
	seen    map[string]bool
	order   []string
	added   bool
	enabled bool
}

func loadRingLedger() *ringLedger {
	ledger := &ringLedger{seen: map[string]bool{}}
	path, err := ringLedgerPath()
	if err != nil {
		return ledger
	}
	ledger.path, ledger.enabled = path, true
	raw, err := os.ReadFile(path)
	if err != nil {
		return ledger
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if key := strings.TrimSpace(line); key != "" && !ledger.seen[key] {
			ledger.seen[key] = true
			ledger.order = append(ledger.order, key)
		}
	}
	return ledger
}

// mark reports whether key is new, and stages it for commit if so.
func (l *ringLedger) mark(key string) bool {
	if !l.enabled || l.seen[key] {
		return false
	}
	l.seen[key] = true
	l.order = append(l.order, key)
	l.added = true
	return true
}

// commit records what was staged. It reports false only when something new
// could not be written, so the caller can refuse to block on an unrecorded ring.
func (l *ringLedger) commit() bool {
	if !l.enabled || !l.added {
		return true
	}
	if len(l.order) > ringLedgerLimit {
		l.order = l.order[len(l.order)-ringLedgerLimit:]
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return false
	}
	if err := os.WriteFile(l.path, []byte(strings.Join(l.order, "\n")+"\n"), 0o600); err != nil {
		return false
	}
	pruneRingLedgers(filepath.Dir(l.path))
	return true
}

const stopBlockKey = "stopblock "

// stopChainFull reports that this session has already been blocked at Stop
// maxStopChain times within stopChainWindow.
func (l *ringLedger) stopChainFull(now time.Time) bool {
	cutoff := now.Add(-stopChainWindow).Unix()
	count := 0
	for _, key := range l.order {
		rest, ok := strings.CutPrefix(key, stopBlockKey)
		if !ok {
			continue
		}
		var at int64
		if _, err := fmt.Sscanf(rest, "%d", &at); err == nil && at > cutoff {
			count++
		}
	}
	return count >= maxStopChain
}

func (l *ringLedger) recordStopBlock(now time.Time) {
	// A unique key per block; mark stages it so the same commit persists it.
	l.mark(fmt.Sprintf("%s%d %d", stopBlockKey, now.Unix(), len(l.order)))
}

func ringLedgerPath() (string, error) {
	session := strings.TrimSpace(os.Getenv(envSessionID))
	if session == "" || !safeLedgerName(session) {
		return "", fmt.Errorf("no agent session in environment")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cache", "codex-orchestrator", "agent-ring", session), nil
}

// safeLedgerName keeps a session id from escaping the ledger directory. The id
// is a UUID from the wrapper's own environment, but it reaches the filesystem
// as a path element, so it is checked rather than trusted.
func safeLedgerName(value string) bool {
	if len(value) > 64 {
		return false
	}
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' {
			continue
		}
		return false
	}
	return true
}

// pruneRingLedgers keeps the directory from growing one file per session
// forever. Nothing signals session end to this process, so age is the only
// usable signal.
func pruneRingLedgers(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	cutoff := time.Now().Add(-ringLedgerTTL)
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		_ = os.Remove(filepath.Join(dir, entry.Name()))
	}
}

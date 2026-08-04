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
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	hookEventStop   = "Stop"
	hookEventPrompt = "UserPromptSubmit"
	// Enough history that a long session cannot ring the same call twice, small
	// enough that the file stays a cheap read at every turn boundary.
	ringLedgerLimit = 256
	ringLedgerTTL   = 24 * time.Hour
)

type mailboxPeer struct {
	Address string `json:"address"`
	Alias   string `json:"alias"`
	Engine  string `json:"engine"`
	FQDN    string `json:"fqdn"`
}

type mailboxEntry struct {
	MessageID      string      `json:"message_id"`
	ConversationID string      `json:"conversation_id"`
	Kind           string      `json:"kind"`
	From           mailboxPeer `json:"from"`
	ExpiresAt      string      `json:"expires_at"`
	ExpiredAt      string      `json:"expired_at"`
}

type mailbox struct {
	Pending []mailboxEntry `json:"pending"`
	Missed  []mailboxEntry `json:"missed"`
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

func runPoll(args []string, stdout, stderr io.Writer) error {
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

	box, err := peekMailbox(5 * time.Second)
	if event == "" {
		if err != nil {
			return err
		}
		return writeJSON(stdout, box)
	}
	// Hook mode is silent on every failure. A host with messaging disabled, a
	// session outside a managed lifecycle, an orchestrator that is down -- none
	// of those are the user's problem mid-turn, and a hook that reports them
	// would put a wrapper diagnostic in front of unrelated work every time.
	if err != nil || box == nil {
		return nil
	}
	return emitHook(stdout, event, box)
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

func emitHook(stdout io.Writer, event string, box *mailbox) error {
	fresh, ledger := unrung(event, box)
	if len(fresh) == 0 {
		return nil
	}
	summary := ringSummary(fresh)
	// Only commit the ledger once the ring is certain to be emitted, so a write
	// that fails here cannot silently swallow a call.
	ledger.commit()

	if event == hookEventPrompt {
		return writeJSON(stdout, map[string]any{
			"hookSpecificOutput": map[string]any{
				"hookEventName":     hookEventPrompt,
				"additionalContext": summary.context,
			},
			"systemMessage": summary.human,
		})
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

func ringSummary(fresh []mailboxEntry) ringText {
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
		agent.WriteString(
			"\nThis is a ring, not the message: the body is only released when you collect it. " +
				"To answer, use the #call skill as receiver -- `agent_listen` claims the delivery and binds " +
				"this session receive-capable. To decline, say so and carry on; it will not ring again.\n")
		fmt.Fprintf(&human, "☎ %s waiting from %s", plural(len(pending), "call", "calls"), pending[0].From.name())
		if len(pending) > 1 {
			fmt.Fprintf(&human, " and %d more", len(pending)-1)
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

func (l *ringLedger) commit() {
	if !l.enabled || !l.added {
		return
	}
	if len(l.order) > ringLedgerLimit {
		l.order = l.order[len(l.order)-ringLedgerLimit:]
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return
	}
	_ = os.WriteFile(l.path, []byte(strings.Join(l.order, "\n")+"\n"), 0o600)
	pruneRingLedgers(filepath.Dir(l.path))
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

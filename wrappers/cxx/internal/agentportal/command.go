package agentportal

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"
)

// RunCommand implements the credential-free `cxx portal` helper used from a
// managed agent tool call. It can only address the session inherited through
// the supervising cxx process.
func RunCommand(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		printCommandHelp(stdout)
		return 0
	}
	switch args[0] {
	case "status":
		return runStatus(stdout, stderr)
	case "notify":
		return runNotify(args[1:], stdout, stderr)
	case "say":
		return runSay(args[1:], stdout, stderr)
	case "ask":
		return runAsk(args[1:], stdout, stderr)
	case "wait":
		return runWait(args[1:], stdout, stderr)
	case "accept":
		return runAccept(args[1:], stdout, stderr)
	case "leave":
		return runLeave(stdout, stderr)
	default:
		fmt.Fprintf(stderr, "cxx portal: unknown command %q\n", args[0])
		printCommandHelp(stderr)
		return 2
	}
}

func runStatus(stdout, stderr io.Writer) int {
	session, err := SessionFromEnvironment(8 * time.Second)
	if err != nil {
		fmt.Fprintln(stderr, "cxx portal:", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := session.Heartbeat(ctx, "", ""); err != nil {
		fmt.Fprintln(stderr, "cxx portal:", err)
		return 1
	}
	return emitJSON(stdout, stderr, map[string]any{"status": "ok", "session_id": session.ID, "engine": session.Engine})
}

func runNotify(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("cxx portal notify", flag.ContinueOnError)
	flags.SetOutput(stderr)
	summary := flags.String("summary", "", "safe attention summary")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if strings.TrimSpace(*summary) == "" {
		fmt.Fprintln(stderr, "cxx portal notify: --summary is required")
		return 2
	}
	session, err := SessionFromEnvironment(15 * time.Second)
	if err != nil {
		fmt.Fprintln(stderr, "cxx portal:", err)
		return 1
	}
	// Deliberately NOT relay_action=poll. Opening the relay here made the portal
	// writable for a full relay window on the strength of a notice alone -- and
	// notifying is exactly what an agent does immediately before its turn ends,
	// so the portal spent that window reporting "Listening" against a session
	// with nothing polling it. Anything queued into that window was accepted,
	// never claimed, and silently discarded.
	//
	// Only a live `cxx portal wait` iteration opens the relay now, so the state
	// means what it says. The cost is that a notice can briefly be visible
	// before the loop's first poll lands; the relay opens within a second on
	// that path, and the window is honest rather than inverted.
	heartbeatCtx, heartbeatCancel := context.WithTimeout(context.Background(), 8*time.Second)
	err = session.Heartbeat(heartbeatCtx, "", "")
	heartbeatCancel()
	if err != nil {
		fmt.Fprintln(stderr, "cxx portal:", err)
		return 1
	}
	eventCtx, eventCancel := context.WithTimeout(context.Background(), 14*time.Second)
	err = session.Event(eventCtx, newUUID(), "attention", map[string]any{"summary": strings.TrimSpace(*summary)})
	eventCancel()
	if err != nil {
		fmt.Fprintln(stderr, "cxx portal:", err)
		return 1
	}
	return emitJSON(stdout, stderr, map[string]any{"status": "queued", "session_id": session.ID, "type": "attention"})
}

func runSay(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("cxx portal say", flag.ContinueOnError)
	flags.SetOutput(stderr)
	text := flags.String("text", "", "safe assistant response")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if strings.TrimSpace(*text) == "" {
		fmt.Fprintln(stderr, "cxx portal say: --text is required")
		return 2
	}
	return sendEvent("assistant_message", map[string]any{"text": strings.TrimSpace(*text)}, stdout, stderr)
}

func runAsk(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("cxx portal ask", flag.ContinueOnError)
	flags.SetOutput(stderr)
	question := flags.String("question", "", "question shown in the portal")
	optionsRaw := flags.String("options", "", "optional | separated choices")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if strings.TrimSpace(*question) == "" {
		fmt.Fprintln(stderr, "cxx portal ask: --question is required")
		return 2
	}
	promptID := newUUID()
	payload := map[string]any{
		"question":     strings.TrimSpace(*question),
		"allow_answer": true,
		"prompt_id":    promptID,
	}
	if choices := splitOptions(*optionsRaw); len(choices) > 0 {
		payload["options"] = choices
	}
	return sendEvent("waiting_input", payload, stdout, stderr)
}

// sendEvent publishes one event. `say` and `ask` both mean the agent has come
// back from whatever it accepted -- reporting a result or asking for input --
// so both release the turn. Clearing a turn that was never set is a no-op, so
// this is safe outside the relay loop too.
func sendEvent(eventType string, payload map[string]any, stdout, stderr io.Writer) int {
	session, err := SessionFromEnvironment(15 * time.Second)
	if err != nil {
		fmt.Fprintln(stderr, "cxx portal:", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 14*time.Second)
	defer cancel()
	if err := session.Event(ctx, newUUID(), eventType, payload); err != nil {
		fmt.Fprintln(stderr, "cxx portal:", err)
		return 1
	}
	turnCtx, turnCancel := context.WithTimeout(context.Background(), 8*time.Second)
	noTurn := ""
	_ = session.HeartbeatTurn(turnCtx, "", "", &noTurn)
	turnCancel()
	return emitJSON(stdout, stderr, map[string]any{"status": "queued", "session_id": session.ID, "type": eventType})
}

func runWait(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("cxx portal wait", flag.ContinueOnError)
	flags.SetOutput(stderr)
	seconds := flags.Int("seconds", 20, "long-poll duration (0-25)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *seconds < 0 || *seconds > 25 {
		fmt.Fprintln(stderr, "cxx portal wait: --seconds must be between 0 and 25")
		return 2
	}
	session, err := SessionFromEnvironment(time.Duration(*seconds+10) * time.Second)
	if err != nil {
		fmt.Fprintln(stderr, "cxx portal:", err)
		return 1
	}
	claimID := newUUID()

	// One pass, not a retry loop. `claimWithRetry` already long-polls for the
	// whole `--seconds` window server-side, so every branch below is terminal
	// and the enclosing `for` never reached a second iteration — along with the
	// deadline arithmetic that clamped a `wait` which could not exceed it.
	// staticcheck flagged the loop (SA4004); the behaviour is unchanged.

	// Parked is not working: reaching the poll means the previous instruction
	// is done, so the turn is cleared in the same beat that re-opens the relay.
	heartbeatCtx, heartbeatCancel := context.WithTimeout(context.Background(), 8*time.Second)
	noTurn := ""
	if heartbeatErr := session.HeartbeatTurn(heartbeatCtx, "", "poll", &noTurn); heartbeatErr != nil {
		heartbeatCancel()
		fmt.Fprintln(stderr, "cxx portal:", heartbeatErr)
		return 1
	}
	heartbeatCancel()

	message, claimErr := claimWithRetry(session, claimID, *seconds)
	if claimErr != nil {
		if isRetryableAmbiguous(claimErr) {
			return emitJSON(stdout, stderr, map[string]any{
				"status": "transient_error", "session_id": session.ID,
			})
		}
		fmt.Fprintln(stderr, "cxx portal:", claimErr)
		return 1
	}
	if message == nil {
		return emitJSON(stdout, stderr, map[string]any{"status": "idle", "session_id": session.ID})
	}
	return emitJSON(stdout, stderr, map[string]any{
		"status":      "instruction",
		"message_id":  message.MessageID,
		"lease_owner": message.LeaseOwner,
		"kind":        message.Kind,
		"prompt_id":   message.PromptID,
		"content":     message.Content,
		"created_at":  message.CreatedAt,
	})
}

func runAccept(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("cxx portal accept", flag.ContinueOnError)
	flags.SetOutput(stderr)
	messageID := flags.String("message-id", "", "message ID returned by portal wait")
	leaseOwner := flags.String("lease-owner", "", "lease owner returned by portal wait")
	upstreamID := flags.String("upstream-id", "cxx-relay", "optional engine correlation ID")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if strings.TrimSpace(*messageID) == "" || strings.TrimSpace(*leaseOwner) == "" {
		fmt.Fprintln(stderr, "cxx portal accept: --message-id and --lease-owner are required")
		return 2
	}
	session, err := SessionFromEnvironment(15 * time.Second)
	if err != nil {
		fmt.Fprintln(stderr, "cxx portal:", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 14*time.Second)
	defer cancel()
	message := &ClaimedMessage{MessageID: strings.TrimSpace(*messageID), LeaseOwner: strings.TrimSpace(*leaseOwner)}
	if err := session.Acknowledge(ctx, message, "accepted", strings.TrimSpace(*upstreamID), ""); err != nil {
		fmt.Fprintln(stderr, "cxx portal:", err)
		return 1
	}
	// The agent is now executing rather than polling, and nothing refreshes the
	// relay until it comes back. Claiming the turn is what keeps the portal
	// reporting "Working" instead of decaying to "Not listening" mid-task.
	// A failure here costs a label, not the instruction, so it is not fatal.
	turnCtx, turnCancel := context.WithTimeout(context.Background(), 8*time.Second)
	_ = session.HeartbeatTurn(turnCtx, "", "", &message.MessageID)
	turnCancel()
	return emitJSON(stdout, stderr, map[string]any{"status": "accepted", "message_id": message.MessageID})
}

func claimWithRetry(session *Session, claimID string, waitSeconds int) (*ClaimedMessage, error) {
	var message *ClaimedMessage
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		attemptWait := waitSeconds
		if attempt > 0 {
			// The stable claim ID recovers a committed lease immediately. Avoid a
			// second full long-poll when the first response was lost.
			attemptWait = 0
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(attemptWait+8)*time.Second)
		message, err = session.Claim(ctx, attemptWait, claimID)
		cancel()
		if err == nil || !isRetryableAmbiguous(err) {
			return message, err
		}
	}
	return message, err
}

func runLeave(stdout, stderr io.Writer) int {
	session, err := SessionFromEnvironment(10 * time.Second)
	if err != nil {
		fmt.Fprintln(stderr, "cxx portal:", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := session.Heartbeat(ctx, "", "close"); err != nil {
		fmt.Fprintln(stderr, "cxx portal:", err)
		return 1
	}
	return emitJSON(stdout, stderr, map[string]any{"status": "closed", "session_id": session.ID})
}

func splitOptions(raw string) []string {
	parts := strings.Split(raw, "|")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			out = append(out, value)
		}
		if len(out) == 20 {
			break
		}
	}
	return out
}

func writeJSON(w io.Writer, value any) error {
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(true)
	return encoder.Encode(value)
}

func emitJSON(stdout, stderr io.Writer, value any) int {
	if err := writeJSON(stdout, value); err != nil {
		fmt.Fprintln(stderr, "cxx portal: write response:", err)
		return 1
	}
	return 0
}

func printCommandHelp(w io.Writer) {
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  cxx portal status")
	fmt.Fprintln(w, "  cxx portal notify --summary <safe-summary>")
	fmt.Fprintln(w, "  cxx portal say --text <safe-assistant-response>")
	fmt.Fprintln(w, "  cxx portal ask --question <question> [--options 'one|two']")
	fmt.Fprintln(w, "  cxx portal wait [--seconds 20]")
	fmt.Fprintln(w, "  cxx portal accept --message-id <id> --lease-owner <lease>")
	fmt.Fprintln(w, "  cxx portal leave")
}

package agentbus

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// RunCommand implements the global `cxx agent` surface. Message content is
// accepted only from stdin; flags carry routing metadata, never peer text.
func RunCommand(args []string, stdin io.Reader, stdout, stderr io.Writer, version string) int {
	if len(args) == 0 {
		printHelp(stderr)
		return 2
	}
	var err error
	switch args[0] {
	case "list", "peers":
		err = runList(args[1:], stdout, stderr)
	case "send":
		err = runSend(args[1:], stdin, stdout, stderr, false)
	case "request":
		err = runSend(args[1:], stdin, stdout, stderr, true)
	case "wait":
		err = runWait(args[1:], stdout, stderr)
	case "reply":
		err = runReply(args[1:], stdin, stdout, stderr)
	case "message":
		err = runMessage(args[1:], stdout)
	case "cancel":
		err = runCancel(args[1:], stdout, stderr)
	case "status":
		err = runStatus(stdout)
	case "service":
		err = runServiceCommand(args[1:], stdout, stderr)
	case "worker":
		err = runWorkerCommand(args[1:], stdout, stderr, version)
	case "mcp":
		err = runMCPCommand(args[1:], stdin, stdout, stderr)
	case "--help", "-h", "help":
		printHelp(stdout)
		return 0
	default:
		fmt.Fprintf(stderr, "cxx agent: unknown command %q\n", args[0])
		printHelp(stderr)
		return 2
	}
	if err != nil {
		fmt.Fprintln(stderr, "cxx agent:", err)
		return 1
	}
	return 0
}

func runList(args []string, stdout, stderr io.Writer) error {
	flags := newFlagSet("cxx agent list", stderr)
	engine := flags.String("engine", "", "codex or claude")
	host := flags.Int64("host", 0, "host id")
	online := flags.Bool("online", false, "exclude offline addresses")
	_ = flags.Bool("json", true, "JSON output (always enabled)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(flags.Args(), " "))
	}
	client, err := sessionClientFromEnv(30 * time.Second)
	if err != nil {
		return err
	}
	body := map[string]any{"include_offline": !*online}
	if *engine != "" {
		body["engine"] = *engine
	}
	if *host > 0 {
		body["host_id"] = *host
	}
	var out map[string]any
	if err := client.post(context.Background(), "list", body, &out); err != nil {
		return err
	}
	return writeJSON(stdout, out)
}

func runSend(args []string, stdin io.Reader, stdout, stderr io.Writer, request bool) error {
	name := "cxx agent send"
	if request {
		name = "cxx agent request"
	}
	flags := newFlagSet(name, stderr)
	to := flags.String("to", "", "target agent address")
	stdinFlag := flags.Bool("stdin", false, "read message body from stdin")
	conversation := flags.String("conversation", "", "existing conversation UUID")
	ttl := flags.Int("ttl-seconds", 0, "queued TTL (60..604800)")
	waitSeconds := flags.Int("wait-seconds", 25, "request wait (0..25 seconds)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || strings.TrimSpace(*to) == "" {
		return errorsUsage(name, "--to and --stdin are required")
	}
	if *ttl != 0 && (*ttl < 60 || *ttl > 604800) {
		return errorsUsage(name, "--ttl-seconds must be between 60 and 604800")
	}
	if request && (*waitSeconds < 0 || *waitSeconds > 25) {
		return errorsUsage(name, "--wait-seconds must be between 0 and 25")
	}
	content, err := readMessageBody(stdin, *stdinFlag)
	if err != nil {
		return err
	}
	client, err := sessionClientFromEnv(35 * time.Second)
	if err != nil {
		return err
	}
	body := map[string]any{
		"to":                strings.TrimSpace(*to),
		"content":           content,
		"client_message_id": newUUID(),
		"kind":              map[bool]string{false: "message", true: "request"}[request],
	}
	if *conversation != "" {
		body["conversation_id"] = strings.TrimSpace(*conversation)
	}
	if *ttl != 0 {
		body["ttl_seconds"] = *ttl
	}
	var sent map[string]any
	if err := client.post(context.Background(), "send", body, &sent); err != nil {
		return err
	}
	if !request {
		return writeJSON(stdout, sent)
	}
	message, _ := sent["message"].(map[string]any)
	conversationID, _ := message["conversation_id"].(string)
	if conversationID == "" {
		return errorsUsage(name, "server response omitted conversation_id")
	}
	var waited map[string]any
	if err := client.post(context.Background(), "wait", map[string]any{
		"conversation_id": conversationID,
		"after":           messageSequence(message),
		"seconds":         *waitSeconds,
	}, &waited); err != nil {
		return err
	}
	return writeJSON(stdout, map[string]any{"sent": sent, "result": waited})
}

func runWait(args []string, stdout, stderr io.Writer) error {
	flags := newFlagSet("cxx agent wait", stderr)
	conversation := flags.String("conversation", "", "conversation UUID")
	after := flags.Int64("after", 0, "last observed sequence")
	seconds := flags.Int("seconds", 25, "long poll duration")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *conversation == "" || *seconds < 0 || *seconds > 25 {
		return errorsUsage("cxx agent wait", "--conversation is required and --seconds must be 0..25")
	}
	client, err := sessionClientFromEnv(35 * time.Second)
	if err != nil {
		return err
	}
	var out map[string]any
	if err := client.post(context.Background(), "wait", map[string]any{"conversation_id": *conversation, "after": *after, "seconds": *seconds}, &out); err != nil {
		return err
	}
	return writeJSON(stdout, out)
}

func runReply(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	flags := newFlagSet("cxx agent reply", stderr)
	messageID := flags.String("message-id", "", "message being answered")
	stdinFlag := flags.Bool("stdin", false, "read reply from stdin")
	ttl := flags.Int("ttl-seconds", 0, "queued TTL")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || strings.TrimSpace(*messageID) == "" {
		return errorsUsage("cxx agent reply", "--message-id and --stdin are required")
	}
	if *ttl != 0 && (*ttl < 60 || *ttl > 604800) {
		return errorsUsage("cxx agent reply", "--ttl-seconds must be between 60 and 604800")
	}
	content, err := readMessageBody(stdin, *stdinFlag)
	if err != nil {
		return err
	}
	body := map[string]any{"message_id": *messageID, "content": content, "client_message_id": newUUID()}
	if *ttl != 0 {
		body["ttl_seconds"] = *ttl
	}
	client, err := sessionClientFromEnv(30 * time.Second)
	if err != nil {
		return err
	}
	var out map[string]any
	if err := client.post(context.Background(), "reply", body, &out); err != nil {
		return err
	}
	return writeJSON(stdout, out)
}

func runMessage(args []string, stdout io.Writer) error {
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		return errorsUsage("cxx agent message", "one message UUID is required")
	}
	client, err := sessionClientFromEnv(15 * time.Second)
	if err != nil {
		return err
	}
	var out map[string]any
	if err := client.post(context.Background(), "message", map[string]any{"message_id": args[0]}, &out); err != nil {
		return err
	}
	return writeJSON(stdout, out)
}

func runCancel(args []string, stdout, stderr io.Writer) error {
	flags := newFlagSet("cxx agent cancel", stderr)
	conversation := flags.String("conversation", "", "conversation UUID")
	reason := flags.String("reason", "", "short cancellation reason")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || strings.TrimSpace(*conversation) == "" {
		return errorsUsage("cxx agent cancel", "--conversation is required")
	}
	client, err := sessionClientFromEnv(15 * time.Second)
	if err != nil {
		return err
	}
	var out map[string]any
	if err := client.post(context.Background(), "cancel", map[string]any{"conversation_id": *conversation, "reason": emptyToNil(*reason)}, &out); err != nil {
		return err
	}
	return writeJSON(stdout, out)
}

func runStatus(stdout io.Writer) error {
	status := map[string]any{"session_available": false}
	if client, err := sessionClientFromEnv(5 * time.Second); err == nil {
		status["session_available"] = true
		status["session_id"] = client.id
	}
	service, _ := serviceStatus()
	status["service"] = service
	return writeJSON(stdout, status)
}

func runWorkerCommand(args []string, stdout, stderr io.Writer, version string) error {
	flags := newFlagSet("cxx agent worker", stderr)
	foreground := flags.Bool("foreground", false, "run the relay in this process")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if !*foreground || flags.NArg() != 0 {
		return errorsUsage("cxx agent worker", "--foreground is required")
	}
	return RunWorker(context.Background(), version, stdout, stderr)
}

func newFlagSet(name string, stderr io.Writer) *flag.FlagSet {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(stderr)
	return flags
}

func errorsUsage(command, text string) error {
	return fmt.Errorf("%s: %s", command, text)
}

func messageSequence(message map[string]any) int64 {
	switch value := message["sequence"].(type) {
	case float64:
		return int64(value)
	case json.Number:
		parsed, _ := value.Int64()
		return parsed
	case string:
		parsed, _ := strconv.ParseInt(value, 10, 64)
		return parsed
	default:
		return 0
	}
}

func emptyToNil(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func printHelp(w io.Writer) {
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  cxx agent list [--engine codex|claude] [--online]")
	fmt.Fprintln(w, "  cxx agent send --to agent:<id> --stdin [--conversation <id>]")
	fmt.Fprintln(w, "  cxx agent request --to agent:<id> --stdin [--wait-seconds 25]")
	fmt.Fprintln(w, "  cxx agent wait --conversation <id> [--after <sequence>] [--seconds 25]")
	fmt.Fprintln(w, "  cxx agent reply --message-id <id> --stdin")
	fmt.Fprintln(w, "  cxx agent message <id>")
	fmt.Fprintln(w, "  cxx agent cancel --conversation <id>")
	fmt.Fprintln(w, "  cxx agent status")
	fmt.Fprintln(w, "  cxx agent service install|remove|start|stop|restart|status")
	fmt.Fprintln(w, "  cxx agent worker --foreground")
	fmt.Fprintln(w, "  cxx agent mcp [--channel]")
}

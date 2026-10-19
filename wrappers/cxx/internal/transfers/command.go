package transfers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

type options struct {
	action, operand, output, engine string
	ttl                             int64
	resume, overwrite, json         bool
}

const usage = "cxx transfer put FILE [--ttl-seconds 3600] [--resume] [--engine ENGINE] [--json]\ncxx transfer get ID --output FILE [--resume] [--overwrite] [--engine ENGINE] [--json]"

func parse(args []string, selected string) (options, error) {
	o := options{engine: selected, ttl: 3600}
	if len(args) == 0 {
		return o, fmt.Errorf("%s", usage)
	}
	o.action = args[0]
	if o.action != "put" && o.action != "get" {
		return o, fmt.Errorf("%s", usage)
	}
	for i := 1; i < len(args); i++ {
		switch args[i] {
		case "--resume":
			o.resume = true
		case "--overwrite":
			o.overwrite = true
		case "--json":
			o.json = true
		case "--output", "--engine", "--ttl-seconds":
			flag := args[i]
			i++
			if i >= len(args) {
				return o, fmt.Errorf("%s requires a value", flag)
			}
			switch flag {
			case "--output":
				o.output = args[i]
			case "--engine":
				o.engine = args[i]
			case "--ttl-seconds":
				n, e := strconv.ParseInt(args[i], 10, 64)
				if e != nil || n < 0 || n > 0xffffffff {
					return o, fmt.Errorf("invalid TTL")
				}
				o.ttl = n
			}
		default:
			if o.operand != "" || strings.HasPrefix(args[i], "-") {
				return o, fmt.Errorf("unexpected transfer argument %q", args[i])
			}
			o.operand = args[i]
		}
	}
	if o.engine == "" {
		o.engine = os.Getenv("CXX_AGENT_PORTAL_ENGINE")
	}
	if o.engine == "" {
		o.engine = "codex"
	}
	if o.engine != "codex" && o.engine != "claude" && o.engine != "grok" {
		return o, fmt.Errorf("engine must be codex, claude or grok")
	}
	if o.operand == "" || o.action == "get" && o.output == "" {
		return o, fmt.Errorf("%s", usage)
	}
	if o.action == "put" && (o.output != "" || o.overwrite) {
		return o, fmt.Errorf("--output and --overwrite apply to downloads")
	}
	return o, nil
}
func Command(args []string, selected string, stdout, stderr io.Writer) int {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Fprintln(stdout, usage)
		return 0
	}
	o, err := parse(args, selected)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	key, err := signing.PublicKey()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	path, err := config.DefaultPathForEngine(o.engine)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	cfg, _, err := fleetconfig.LoadOrRecover(ctx, path, key, o.engine)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if cfg.EngineSuspended(o.engine) {
		fmt.Fprintln(stderr, "transfer: engine is suspended")
		return 1
	}
	client, err := NewClient(cfg, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	var result Transfer
	if o.action == "put" {
		result, err = client.Put(ctx, o.operand, o.ttl, o.resume)
	} else {
		result, err = client.Get(ctx, o.operand, o.output, o.resume, o.overwrite)
	}
	if err != nil {
		reportFailure(err, o.json, stdout, stderr)
		return 1
	}
	if o.json {
		if err = json.NewEncoder(stdout).Encode(result); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	} else {
		fmt.Fprintf(stdout, "%s  %d bytes  SHA-256 %s  expires %s\n", result.ID, result.Size, result.SHA256, result.ExpiresAt)
	}
	return 0
}

// reportFailure prints the error, and for an upload whose journal exists also
// the transfer ID with the resume and abandon steps. With --json the same
// recovery facts go to stdout as one object; the exit status stays 1.
func reportFailure(err error, asJSON bool, stdout, stderr io.Writer) {
	fmt.Fprintln(stderr, "transfer:", err)
	var put *PutError
	if !errors.As(err, &put) {
		return
	}
	fmt.Fprintln(stderr, "transfer:", put.Guidance())
	if asJSON {
		_ = json.NewEncoder(stdout).Encode(map[string]any{
			"error":          err.Error(),
			"id":             put.ID,
			"outcome":        "unknown",
			"journal":        put.Journal,
			"resume_command": put.ResumeCommand(),
			"abandon":        "delete transfer " + put.ID + " (MCP transfer_delete), then remove the journal",
		})
	}
}

package remote

import (
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// RunCommand implements the global `cxx remote` surface.
//
// Every leaf returns an error and the dispatcher renders it, so there is one
// place where an error becomes JSON and one place where it becomes an exit
// code. Stdout carries exactly one JSON object; every diagnostic goes to
// stderr, because a single stray line on stdout corrupts every caller that
// pipes this.
func RunCommand(args []string, stdin io.Reader, stdout, stderr io.Writer, version string) int {
	if len(args) == 0 {
		printHelp(stderr)
		return ExitUsage
	}
	run := &runner{stdin: stdin, stdout: stdout, stderr: stderr, version: version}
	var err error
	// The fleet switch is checked once, here, and only for the verbs that reach
	// a target. Doing it per leaf would mean every new verb is one forgotten
	// call away from being ungated.
	if !runsOnTarget(args[0]) && !onTargetByEnv() && !isHelp(args[0]) {
		if err := requireEnabled(); err != nil {
			if emitErr := emitError(stdout, err); emitErr != nil {
				fmt.Fprintln(stderr, "cxx remote:", emitErr)
			}
			fmt.Fprintln(stderr, "cxx remote:", err)
			return exitFor(err)
		}
	}
	switch args[0] {
	case "info":
		err = run.info(args[1:])
	case "exec":
		err = run.exec(args[1:])
	case "read":
		err = run.read(args[1:])
	case "write":
		err = run.write(args[1:])
	case "wait":
		err = run.wait(args[1:])
	case "signal":
		err = run.signal(args[1:])
	case "ps":
		err = run.ps(args[1:])
	case "rm":
		err = run.rm(args[1:])
	case "get":
		err = run.get(args[1:])
	case "put":
		err = run.put(args[1:])
	case "push":
		err = run.sync(args[1:], directionPush)
	case "pull":
		err = run.sync(args[1:], directionPull)
	case "down":
		err = run.down(args[1:])
	case "agent-info", "job", "fs", "supervise":
		err = run.remoteSide(args)
	case "--help", "-h", "help":
		printHelp(stdout)
		return ExitOK
	default:
		fmt.Fprintf(stderr, "cxx remote: unknown command %q\n", args[0])
		printHelp(stderr)
		return ExitUsage
	}
	if err != nil {
		if emitErr := emitError(stdout, err); emitErr != nil {
			fmt.Fprintln(stderr, "cxx remote:", emitErr)
		}
		fmt.Fprintln(stderr, "cxx remote:", err)
		return exitFor(err)
	}
	return ExitOK
}

type runner struct {
	stdin   io.Reader
	stdout  io.Writer
	stderr  io.Writer
	version string
}

type syncDirection int

const (
	directionPush syncDirection = iota
	directionPull
)

func newFlagSet(name string, stderr io.Writer) *flag.FlagSet {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(stderr)
	return flags
}

// repeated collects a flag given more than once, in order.
type repeated []string

func (r *repeated) String() string { return strings.Join(*r, ",") }

func (r *repeated) Set(value string) error {
	*r = append(*r, value)
	return nil
}

// byteSize accepts a plain count or a suffixed one ("64MiB", "4M", "512k").
// Binary and decimal suffixes both mean powers of two here: nobody asking for a
// 64MB log buffer means 64,000,000, and silently differing by 7% would only
// ever surface as an off-by-a-bit in a dropped-byte count.
type byteSize int64

func (b *byteSize) String() string { return strconv.FormatInt(int64(*b), 10) }

func (b *byteSize) Set(value string) error {
	text := strings.TrimSpace(value)
	if text == "" {
		return fmt.Errorf("empty size")
	}
	multiplier := int64(1)
	upper := strings.ToUpper(text)
	for _, unit := range []struct {
		suffixes []string
		scale    int64
	}{
		{[]string{"GIB", "GB", "G"}, 1 << 30},
		{[]string{"MIB", "MB", "M"}, 1 << 20},
		{[]string{"KIB", "KB", "K"}, 1 << 10},
		{[]string{"B"}, 1},
	} {
		matched := false
		for _, suffix := range unit.suffixes {
			if trimmed, ok := strings.CutSuffix(upper, suffix); ok {
				upper, multiplier, matched = trimmed, unit.scale, true
				break
			}
		}
		if matched {
			break
		}
	}
	count, err := strconv.ParseInt(strings.TrimSpace(upper), 10, 64)
	if err != nil {
		return fmt.Errorf("not a size: %q", value)
	}
	if count < 0 {
		return fmt.Errorf("size may not be negative: %q", value)
	}
	*b = byteSize(count * multiplier)
	return nil
}

// splitArgv divides a verb's arguments at the first standalone "--".
//
// The separator is required rather than inferred. Letting the first non-flag
// token start the argv would turn a mistyped flag into the command being run on
// somebody else's machine, which is the one mistake here that cannot be undone
// by trying again.
func splitArgv(args []string) (before, argv []string, found bool) {
	for i, arg := range args {
		if arg == "--" {
			return args[:i], args[i+1:], true
		}
	}
	return args, nil, false
}

func usagef(format string, args ...any) error {
	return failf(CodeUsage, format, args...)
}

// requireHost is separate so every verb spells the destination the same way and
// the error reads identically wherever it comes from.
func requireHost(host string) (string, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return "", usagef("--host is required (any destination ssh(1) accepts: an alias from ~/.ssh/config, user@host, or a host name)")
	}
	return host, nil
}

func (r *runner) info(args []string) error {
	flags := newFlagSet("cxx remote info", r.stderr)
	host := flags.String("host", "", "ssh destination")
	if err := flags.Parse(args); err != nil {
		return usagef("%v", err)
	}
	if _, err := requireHost(*host); err != nil {
		return err
	}
	return notImplemented("info")
}

func (r *runner) exec(args []string) error {
	before, argv, found := splitArgv(args)
	flags := newFlagSet("cxx remote exec", r.stderr)
	host := flags.String("host", "", "ssh destination")
	job := flags.String("job", "", "caller-chosen job id; required to re-address the job later")
	flags.String("cwd", "", "working directory on the target (default: the remote home)")
	flags.String("label", "", "free-text label carried in ps output")
	flags.Duration("timeout", 0, "kill the job after this long (0 = no limit)")
	settle := flags.Duration("settle", 250*time.Millisecond, "how long to wait for first output before returning")
	flags.String("stdin-file", "", "feed this file to the job's stdin ('-' for this process's stdin)")
	flags.Bool("close-stdin", false, "send EOF on stdin once the initial input is written")
	flags.Bool("env-clear", false, "start from an empty environment plus PATH/HOME/USER/SHELL/LANG")
	maxLog := byteSize(64 << 20)
	flags.Var(&maxLog, "max-log", "cap the job's captured output; beyond it bytes are counted, not kept")
	var env repeated
	flags.Var(&env, "env", "K=V for the job's environment; repeatable")
	if err := flags.Parse(before); err != nil {
		return usagef("%v", err)
	}
	if _, err := requireHost(*host); err != nil {
		return err
	}
	if !found || len(argv) == 0 {
		return usagef("the command is required after '--', for example: cxx remote exec --host %s -- make -j8", *host)
	}
	if *job != "" {
		if err := ValidJobID(*job); err != nil {
			return err
		}
	}
	for _, pair := range env {
		if !strings.Contains(pair, "=") {
			return usagef("--env %q is not K=V", pair)
		}
	}
	if *settle < 0 || *settle > 5*time.Second {
		return usagef("--settle must be between 0 and 5s, got %s", *settle)
	}
	return notImplemented("exec")
}

func (r *runner) read(args []string) error {
	flags := newFlagSet("cxx remote read", r.stderr)
	host := flags.String("host", "", "ssh destination")
	job := flags.String("job", "", "job id")
	from := flags.Int64("from", 0, "byte cursor into the job's log")
	stream := flags.String("stream", "all", "all, stdout or stderr")
	flags.Bool("follow", false, "block until new output arrives or the job exits")
	flags.Duration("wait", 25*time.Second, "how long --follow may block")
	maxBytes := byteSize(64 << 10)
	flags.Var(&maxBytes, "max-bytes", "cap this response's payload")
	if err := flags.Parse(args); err != nil {
		return usagef("%v", err)
	}
	if _, err := requireHost(*host); err != nil {
		return err
	}
	if err := ValidJobID(*job); err != nil {
		return err
	}
	switch *stream {
	case "all", "stdout", "stderr":
	default:
		return usagef("--stream must be all, stdout or stderr, got %q", *stream)
	}
	if *from < 0 {
		return usagef("--from may not be negative")
	}
	return notImplemented("read")
}

func (r *runner) write(args []string) error {
	flags := newFlagSet("cxx remote write", r.stderr)
	host := flags.String("host", "", "ssh destination")
	job := flags.String("job", "", "job id")
	flags.String("stdin-file", "-", "file to write to the job's stdin ('-' for this process's stdin)")
	flags.Bool("close", false, "send EOF after writing")
	if err := flags.Parse(args); err != nil {
		return usagef("%v", err)
	}
	if _, err := requireHost(*host); err != nil {
		return err
	}
	if err := ValidJobID(*job); err != nil {
		return err
	}
	return notImplemented("write")
}

func (r *runner) wait(args []string) error {
	flags := newFlagSet("cxx remote wait", r.stderr)
	host := flags.String("host", "", "ssh destination")
	job := flags.String("job", "", "job id")
	flags.Duration("timeout", 25*time.Second, "give up waiting after this long and report the job as still running")
	if err := flags.Parse(args); err != nil {
		return usagef("%v", err)
	}
	if _, err := requireHost(*host); err != nil {
		return err
	}
	if err := ValidJobID(*job); err != nil {
		return err
	}
	return notImplemented("wait")
}

// knownSignals is an allowlist rather than a name-to-number lookup: a typo that
// resolved to some other signal would be delivered to a real process group.
var knownSignals = map[string]bool{
	"TERM": true, "INT": true, "KILL": true, "HUP": true,
	"QUIT": true, "USR1": true, "USR2": true,
}

func (r *runner) signal(args []string) error {
	flags := newFlagSet("cxx remote signal", r.stderr)
	host := flags.String("host", "", "ssh destination")
	job := flags.String("job", "", "job id")
	sig := flags.String("signal", "TERM", "TERM, INT, KILL, HUP, QUIT, USR1 or USR2")
	flags.Bool("no-group", false, "signal only the direct child, not its process group")
	if err := flags.Parse(args); err != nil {
		return usagef("%v", err)
	}
	if _, err := requireHost(*host); err != nil {
		return err
	}
	if err := ValidJobID(*job); err != nil {
		return err
	}
	// Upper-case before trimming: TrimPrefix is case sensitive, so trimming
	// first leaves "sigterm" as "SIGTERM" and rejects a spelling everyone uses.
	name := strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(*sig)), "SIG")
	if !knownSignals[name] {
		return usagef("--signal %q is not one of TERM, INT, KILL, HUP, QUIT, USR1, USR2", *sig)
	}
	return notImplemented("signal")
}

func (r *runner) ps(args []string) error {
	flags := newFlagSet("cxx remote ps", r.stderr)
	host := flags.String("host", "", "ssh destination")
	job := flags.String("job", "", "report only this job")
	flags.Bool("all", false, "include jobs that have already exited")
	if err := flags.Parse(args); err != nil {
		return usagef("%v", err)
	}
	if _, err := requireHost(*host); err != nil {
		return err
	}
	if *job != "" {
		if err := ValidJobID(*job); err != nil {
			return err
		}
	}
	return notImplemented("ps")
}

func (r *runner) rm(args []string) error {
	flags := newFlagSet("cxx remote rm", r.stderr)
	host := flags.String("host", "", "ssh destination")
	job := flags.String("job", "", "job id")
	flags.Bool("kill", false, "kill the job's process group first if it is still running")
	if err := flags.Parse(args); err != nil {
		return usagef("%v", err)
	}
	if _, err := requireHost(*host); err != nil {
		return err
	}
	if err := ValidJobID(*job); err != nil {
		return err
	}
	return notImplemented("rm")
}

func (r *runner) get(args []string) error {
	flags := newFlagSet("cxx remote get", r.stderr)
	host := flags.String("host", "", "ssh destination")
	path := flags.String("path", "", "absolute path on the target")
	flags.String("out", "", "write the bytes here instead of into the JSON response")
	if err := flags.Parse(args); err != nil {
		return usagef("%v", err)
	}
	if _, err := requireHost(*host); err != nil {
		return err
	}
	if strings.TrimSpace(*path) == "" {
		return usagef("--path is required")
	}
	return notImplemented("get")
}

func (r *runner) put(args []string) error {
	flags := newFlagSet("cxx remote put", r.stderr)
	host := flags.String("host", "", "ssh destination")
	path := flags.String("path", "", "absolute destination path on the target")
	flags.String("in", "-", "local file to send ('-' for this process's stdin)")
	mode := flags.String("mode", "0644", "octal mode for the created file")
	if err := flags.Parse(args); err != nil {
		return usagef("%v", err)
	}
	if _, err := requireHost(*host); err != nil {
		return err
	}
	if strings.TrimSpace(*path) == "" {
		return usagef("--path is required")
	}
	if _, err := strconv.ParseUint(*mode, 8, 32); err != nil {
		return usagef("--mode %q is not an octal file mode", *mode)
	}
	return notImplemented("put")
}

func (r *runner) sync(args []string, direction syncDirection) error {
	name := "cxx remote push"
	if direction == directionPull {
		name = "cxx remote pull"
	}
	flags := newFlagSet(name, r.stderr)
	host := flags.String("host", "", "ssh destination")
	flags.Bool("delete", false, "remove destination files the source does not have")
	var exclude repeated
	flags.Var(&exclude, "exclude", "glob to skip; repeatable")
	if err := flags.Parse(args); err != nil {
		return usagef("%v", err)
	}
	if _, err := requireHost(*host); err != nil {
		return err
	}
	if flags.NArg() != 2 {
		return usagef("%s needs exactly two directories: SRC and DST", name)
	}
	return notImplemented(strings.TrimPrefix(name, "cxx remote "))
}

func (r *runner) down(args []string) error {
	flags := newFlagSet("cxx remote down", r.stderr)
	host := flags.String("host", "", "ssh destination")
	if err := flags.Parse(args); err != nil {
		return usagef("%v", err)
	}
	if _, err := requireHost(*host); err != nil {
		return err
	}
	return notImplemented("down")
}

// remoteSide covers the verbs this binary invokes on itself across the
// connection. They are dispatched but not advertised: a human has no reason to
// type them, and their arguments are a wire format rather than a UI.
func (r *runner) remoteSide(args []string) error {
	return notImplemented(args[0])
}

func notImplemented(verb string) error {
	return failf(CodeNotImplemented, "cxx remote %s is not implemented yet", verb).with("verb", verb)
}

func isHelp(verb string) bool {
	return verb == "--help" || verb == "-h" || verb == "help"
}

func printHelp(w io.Writer) {
	fmt.Fprintln(w, "Usage: cxx remote <command> --host <ssh destination> [options]")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "  info                                 report the target and the installed remote binary")
	fmt.Fprintln(w, "  exec   [--job ID] [--cwd DIR] -- ARGV...   start a job; returns as soon as it is running")
	fmt.Fprintln(w, "  read   --job ID [--from N] [--follow]      read the job's output from a byte cursor")
	fmt.Fprintln(w, "  write  --job ID [--close]                  write to the job's stdin")
	fmt.Fprintln(w, "  wait   --job ID [--timeout D]              wait, bounded, for the job to finish")
	fmt.Fprintln(w, "  signal --job ID [--signal TERM]            signal the job's process group")
	fmt.Fprintln(w, "  ps     [--all] [--job ID]                  list jobs on the target")
	fmt.Fprintln(w, "  rm     --job ID [--kill]                   forget a job and its output")
	fmt.Fprintln(w, "  get    --path P [--out FILE]               read one remote file")
	fmt.Fprintln(w, "  put    --path P [--in FILE]                write one remote file")
	fmt.Fprintln(w, "  push   SRC_DIR DST_DIR [--delete]          send a directory, sending only what differs")
	fmt.Fprintln(w, "  pull   SRC_DIR DST_DIR [--delete]          fetch a directory, fetching only what differs")
	fmt.Fprintln(w, "  down                                       close this target's shared ssh connection")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Everything after '--' is the argv to run, verbatim; no shell is involved.")
	fmt.Fprintln(w, "Ask for one explicitly when you want one: -- bash -lc 'make && ./deploy.sh'")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "A destination is whatever ssh(1) accepts, so ~/.ssh/config aliases work.")
	fmt.Fprintln(w, "One JSON object is written to stdout; diagnostics go to stderr.")
}

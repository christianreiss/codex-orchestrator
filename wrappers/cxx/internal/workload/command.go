// Package workload implements cooperative local memory admission. It does not
// intercept native tools or constrain any process's memory or thread count.
package workload

import (
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

type options struct {
	memory, reserve uint64
	wait            time.Duration
	command         []string
}

func parseBytes(s string) (uint64, error) {
	for _, u := range []struct {
		name string
		n    uint64
	}{{"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10}, {"B", 1}} {
		if strings.HasSuffix(s, u.name) {
			n, err := strconv.ParseUint(strings.TrimSuffix(s, u.name), 10, 64)
			if err == nil && n > 0 && n <= ^uint64(0)/u.n {
				return n * u.n, nil
			}
			break
		}
	}
	return 0, fmt.Errorf("use a positive whole byte size, for example 512MiB or 8GiB")
}

func parseRun(args []string, stderr io.Writer) (options, error) {
	fs := flag.NewFlagSet("workload run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	memory := fs.String("memory", "", "estimated peak memory, e.g. 8GiB (required)")
	reserve := fs.String("reserve", "", "memory kept free; default 10% of effective RAM, minimum 256MiB")
	wait := fs.Duration("wait", 0, "maximum admission wait; 0 fails immediately")
	if err := fs.Parse(args); err != nil {
		return options{}, err
	}
	m, err := parseBytes(*memory)
	if err != nil {
		return options{}, fmt.Errorf("--memory: %w", err)
	}
	var r uint64
	if *reserve != "" {
		r, err = parseBytes(*reserve)
		if err != nil {
			return options{}, fmt.Errorf("--reserve: %w", err)
		}
	}
	if *wait < 0 || len(fs.Args()) == 0 {
		return options{}, fmt.Errorf("usage: cxx workload run --memory 8GiB [--wait 5m] [--reserve 2GiB] -- command [args...]")
	}
	return options{memory: m, reserve: r, wait: *wait, command: fs.Args()}, nil
}

// Command is shared by all engines and runs before fleet configuration or auth.
func Command(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "help" {
		fmt.Fprintln(stdout, "Usage: cxx workload run --memory 8GiB [--wait 5m] [--reserve 2GiB] -- command [args...]\n       cxx workload status|hold|resume\n       cxx workload release ID --confirm-finished\nLinux, cooperative jobs for this user only. No memory/thread limits or native-session termination.\nJobs started outside this command, Docker/systemd/remote jobs are not covered.\nA crashed wrapper retains uncertain reservations; verify every job descendant ended before release.")
		return 0
	}
	return platformCommand(args, stdin, stdout, stderr)
}

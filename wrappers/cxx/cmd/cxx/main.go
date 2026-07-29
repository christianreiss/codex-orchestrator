// cxx is the single Codex Orchestrator wrapper artifact. It behaves as a
// multicall binary when invoked through the cdx/clx aliases and also supports
// explicit `cxx codex ...` / `cxx claude ...` dispatch.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	claudeapp "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/app/claude"
	codexapp "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/app/codex"
	hostcron "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

func main() {
	os.Exit(run(filepath.Base(os.Args[0]), os.Args[1:], os.Stdout, os.Stderr))
}

func run(invokedAs string, args []string, stdout, stderr io.Writer) int {
	setPersonaBuildInfo()

	switch normalizeProgramName(invokedAs) {
	case "cdx":
		return codexapp.Run(args, stdout, stderr)
	case "clx":
		return claudeapp.Run(args, stdout, stderr)
	case "cxx":
		return runExplicit(args, stdout, stderr)
	default:
		// Update sanity checks execute a uniquely named temporary cxx artifact.
		// Permit only explicit/global cxx grammar for such paths; never guess a
		// persona from an arbitrary filename.
		if len(args) > 0 && (args[0] == "codex" || args[0] == "claude" || strings.HasPrefix(args[0], "-") || args[0] == "help") {
			return runExplicit(args, stdout, stderr)
		}
		fmt.Fprintf(stderr, "cxx: cannot select an engine from invocation name %q\n", invokedAs)
		printSelectorHelp(stderr)
		return 2
	}
}

func runExplicit(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printSelectorHelp(stderr)
		return 2
	}
	switch args[0] {
	case "codex":
		return codexapp.Run(args[1:], stdout, stderr)
	case "claude":
		return claudeapp.Run(args[1:], stdout, stderr)
	case "cron":
		return runHostCron(args[1:], stdout, stderr)
	case "update":
		return runHostUpdate(stdout, stderr)
	case "--version", "--wrapper-version", "-W":
		if len(args) != 1 {
			fmt.Fprintln(stderr, "cxx: global version does not accept arguments")
			return 2
		}
		printVersion(stdout)
		return 0
	case "--help", "-h", "help":
		printSelectorHelp(stdout)
		return 0
	default:
		fmt.Fprintf(stderr, "cxx: unknown engine or global command %q\n", args[0])
		printSelectorHelp(stderr)
		return 2
	}
}

func setPersonaBuildInfo() {
	codexapp.Version, codexapp.Commit, codexapp.BuildDate = Version, Commit, BuildDate
	claudeapp.Version, claudeapp.Commit, claudeapp.BuildDate = Version, Commit, BuildDate
}

func runHostCron(args []string, stdout, stderr io.Writer) int {
	action := "run"
	if len(args) > 0 {
		action = args[0]
		args = args[1:]
	}
	minimal := false
	for _, arg := range args {
		if arg == "--minimal" || arg == "--minimal-output" {
			minimal = true
			continue
		}
		fmt.Fprintf(stderr, "cxx cron: unknown argument %q\n", arg)
		return 2
	}
	ctx := context.Background()
	var err error
	switch action {
	case "install":
		err = hostcron.Install(ctx, nil)
	case "remove":
		err = hostcron.Remove(ctx)
	case "run":
		err = hostcron.Run(ctx, nil, minimal, stdout, stderr)
	default:
		fmt.Fprintf(stderr, "cxx cron: unknown action %q\n", action)
		return 2
	}
	if err != nil {
		fmt.Fprintf(stderr, "cxx cron %s: %v\n", action, err)
		return 1
	}
	if action != "run" {
		pastTense := map[string]string{"install": "installed", "remove": "removed"}
		fmt.Fprintf(stdout, "cron: %s\n", pastTense[action])
	}
	return 0
}

// runHostUpdate selects an installed persona only to authenticate the common
// wrapper update request. Both paths install the same cxx bytes.
func runHostUpdate(stdout, stderr io.Writer) int {
	if path, err := configPathFor("codex"); err == nil {
		return codexapp.Run([]string{"--config", path, "--update"}, stdout, stderr)
	}
	if path, err := configPathFor("claude"); err == nil {
		return claudeapp.Run([]string{"--config", path, "--update"}, stdout, stderr)
	}
	fmt.Fprintln(stderr, "cxx update: no installed engine config found")
	return 1
}

func configPathFor(engine string) (string, error) {
	var envName, filename string
	if engine == "claude" {
		envName, filename = "CLX_CONFIG_PATH", "clx.json"
	} else {
		envName, filename = "CDX_CONFIG_PATH", "cdx.json"
	}
	if value := strings.TrimSpace(os.Getenv(envName)); value != "" {
		if _, err := os.Stat(value); err != nil {
			return "", err
		}
		return value, nil
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".config")
	}
	path := filepath.Join(base, "codex-orchestrator", filename)
	if _, err := os.Stat(path); err != nil {
		return "", err
	}
	return path, nil
}

func normalizeProgramName(name string) string {
	name = strings.TrimSuffix(filepath.Base(name), ".exe")
	return strings.ToLower(name)
}

func printVersion(w io.Writer) {
	fmt.Fprintf(w, "cxx %s (commit %s, built %s, %s/%s)\n", Version, Commit, BuildDate, runtime.GOOS, runtime.GOARCH)
	if signing.HasKey() {
		fmt.Fprintln(w, "signing pubkey: embedded")
	} else {
		fmt.Fprintln(w, "signing pubkey: MISSING (this binary refuses signed configs)")
	}
}

func printSelectorHelp(w io.Writer) {
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  cxx codex [cdx arguments]")
	fmt.Fprintln(w, "  cxx claude [clx arguments]")
	fmt.Fprintln(w, "  cxx update")
	fmt.Fprintln(w, "  cxx cron [install|remove|run]")
	fmt.Fprintln(w, "  cxx --version")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "The cdx and clx aliases select their matching engine automatically.")
}

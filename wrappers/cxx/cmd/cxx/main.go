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

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentbus"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
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

	switch personaForProgramName(invokedAs) {
	case "codex":
		return codexapp.Run(args, stdout, stderr)
	case "claude":
		return claudeapp.Run(args, stdout, stderr)
	case "common":
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
	case "portal":
		return agentportal.RunCommand(args[1:], stdout, stderr)
	case "agent":
		return agentbus.RunCommand(args[1:], os.Stdin, stdout, stderr, Version)
	case "update":
		return runHostUpdate(stdout, stderr)
	case "sync":
		return runHostSync(args[1:], stdout, stderr)
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
// wrapper update request. Both paths install the same cxx bytes, so the persona
// choice must not narrow what happens afterwards: HostSyncAfterUpdate makes the
// re-exec land on `cxx sync`, which converges every installed engine.
func runHostUpdate(stdout, stderr io.Writer) int {
	if path, err := configPathFor("codex"); err == nil {
		codexapp.HostSyncAfterUpdate = true
		return codexapp.Run([]string{"--config", path, "--update"}, stdout, stderr)
	}
	if path, err := configPathFor("claude"); err == nil {
		claudeapp.HostSyncAfterUpdate = true
		return claudeapp.Run([]string{"--config", path, "--update"}, stdout, stderr)
	}
	fmt.Fprintln(stderr, "cxx update: no installed engine config found")
	return 1
}

// engineRunner is a persona entrypoint; parameterized so syncEngines is
// testable without installed configs on disk.
type engineRunner func(args []string, stdout, stderr io.Writer) int

// runHostSync writes fleet-managed content for every installed engine without
// launching either one. Unlike cron, which forks a child per engine precisely so
// a child may re-exec after a self-update, this runs both legs in-process: a
// sync-only lifecycle never re-execs.
func runHostSync(args []string, stdout, stderr io.Writer) int {
	var passthrough []string
	for _, arg := range args {
		switch arg {
		case "--minimal", "--minimal-output", "--silent", "--skip-boot", "--no-banner", "--allow-concurrent-sync":
			passthrough = append(passthrough, arg)
		default:
			fmt.Fprintf(stderr, "cxx sync: unknown argument %q\n", arg)
			return 2
		}
	}
	return syncEngines(passthrough, stdout, stderr, codexapp.Run, claudeapp.Run)
}

// syncEngines walks the engines in the same fixed order the cron coordinator
// uses and returns the worst exit code, so one broken engine cannot hide behind
// a healthy one.
func syncEngines(passthrough []string, stdout, stderr io.Writer, runCodex, runClaude engineRunner) int {
	engines := []struct {
		name string
		run  engineRunner
	}{
		{"codex", runCodex},
		{"claude", runClaude},
	}
	worst := 0
	found := false
	for _, engine := range engines {
		path, err := configPathFor(engine.name)
		if err != nil {
			continue
		}
		found = true
		argv := append([]string{"--config", path, "sync"}, passthrough...)
		if code := engine.run(argv, stdout, stderr); code > worst {
			worst = code
		}
	}
	if !found {
		fmt.Fprintln(stderr, "cxx sync: no installed engine config found")
		return 1
	}
	return worst
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

// personaForProgramName recognizes the stable aliases and the versioned
// aliases left by pre-cxx self-updaters (for example cdx-0.7.2). Only a strict
// numeric release-version suffix selects a persona, so arbitrary executable
// names do not get an implicit engine.
func personaForProgramName(name string) string {
	name = normalizeProgramName(name)
	switch {
	case name == "cdx" || hasVersionedAlias(name, "cdx"):
		return "codex"
	case name == "clx" || hasVersionedAlias(name, "clx"):
		return "claude"
	case name == "cxx":
		return "common"
	default:
		return ""
	}
}

func hasVersionedAlias(name, alias string) bool {
	suffix, ok := strings.CutPrefix(name, alias+"-")
	if !ok {
		return false
	}
	parts := strings.Split(suffix, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
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
	fmt.Fprintln(w, "  cxx sync")
	fmt.Fprintln(w, "  cxx cron [install|remove|run]")
	fmt.Fprintln(w, "  cxx portal [status|notify|say|ask|wait]")
	fmt.Fprintln(w, "  cxx agent [list|send|request|wait|reply|message|cancel|status|service]")
	fmt.Fprintln(w, "  cxx --version")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "The cdx and clx aliases select their matching engine automatically.")
}

// clx — Codex Orchestrator wrapper, engine=claude.
//
// Subcommands: run (default), status, doctor, exec, auth-upload, --version,
// --update, --uninstall, --cron [install|remove|run], --execute.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/log"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/signing"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/uninstall"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/update"
)

// maxRestartDepth caps how many times the wrapper may re-exec itself after a
// self-update before bailing out. Each self-update increments
// CLAUDE_WRAPPER_RESTART_DEPTH; >2 strongly implies a feedback loop.
const maxRestartDepth = 2

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

type flags struct {
	configPath      string
	silent          bool
	debug           bool
	minimal         bool
	skipBoot        bool
	versionFlag     bool
	updateFlag      bool
	uninstallFlag   bool
	cronArgs        []string
	executePrompt   string
	forceIPv4       bool
	allowConc       bool
	helpPassthrough bool
	// Forwarded straight to the upstream Claude CLI through the normal
	// lifecycle. Recognised so parseFlags doesn't reject them.
	continueSession bool
	resumeSession   string
}

// reservedClaudeSubcommands lists Claude CLI subcommands whose `--help`
// invocations route straight to the upstream binary.
var reservedClaudeSubcommands = map[string]bool{
	"login":    true,
	"logout":   true,
	"mcp":      true,
	"config":   true,
	"doctor":   true,
	"sessions": true,
	"resume":   true,
	"help":     true,
}

// isHelpPassthrough returns true when argv requests upstream Claude help text.
// Matched forms:
//   - top-level `--help` / `-h` appearing before any positional token
//   - bare `help` as the first positional token
//   - `<reserved-subcommand> ... --help` / `<reserved-subcommand> ... -h`
func isHelpPassthrough(args []string) bool {
	if len(args) == 0 {
		return false
	}
	firstPositional := ""
	helpBeforePositional := false
	for _, a := range args {
		if a == "--" {
			break
		}
		if a == "--help" || a == "-h" {
			if firstPositional == "" {
				helpBeforePositional = true
			}
			continue
		}
		if strings.HasPrefix(a, "-") {
			continue
		}
		if firstPositional == "" {
			firstPositional = a
		}
	}
	if firstPositional == "help" {
		return true
	}
	if helpBeforePositional {
		return true
	}
	if firstPositional != "" && reservedClaudeSubcommands[firstPositional] {
		for _, a := range args {
			if a == "--" {
				break
			}
			if a == "--help" || a == "-h" {
				return true
			}
		}
	}
	return false
}

func run(args []string, stdout, stderr io.Writer) int {
	depth, _ := strconv.Atoi(os.Getenv("CLAUDE_WRAPPER_RESTART_DEPTH"))
	if depth > maxRestartDepth {
		fmt.Fprintf(stderr, "clx: restart depth %d exceeded cap %d — refusing to continue\n", depth, maxRestartDepth)
		return 70
	}

	snap := make([]string, len(args))
	copy(snap, args)
	update.SnapshottedArgv = snap

	cron.WrapperVersion = Version

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	f, positional, passthrough := parseFlags(args)

	// Help passthrough bypasses every wrapper side effect: no lock, no sync,
	// no update check, no boot screen, no footer. argv is unmodified.
	if f.helpPassthrough {
		cli, err := claude.FindCLI()
		if err != nil {
			fmt.Fprintln(stderr, "clx --help:", err)
			return 127
		}
		execArgv := append([]string{cli}, args...)
		if err := syscall.Exec(cli, execArgv, os.Environ()); err != nil {
			fmt.Fprintln(stderr, "clx --help: exec failed:", err)
			return 127
		}
		return 0
	}

	logger := log.Setup(f.silent || f.debug)

	if f.versionFlag {
		fmt.Fprintf(stdout, "clx %s (commit %s, built %s, %s/%s)\n", Version, Commit, BuildDate, runtime.GOOS, runtime.GOARCH)
		if signing.HasKey() {
			fmt.Fprintln(stdout, "signing pubkey: embedded")
		} else {
			fmt.Fprintln(stdout, "signing pubkey: MISSING (this binary refuses signed configs)")
		}
		return 0
	}

	if f.configPath == "" {
		f.configPath = config.DefaultPath()
	}
	pubkey, _ := signing.PublicKey()
	cfg, err := config.Load(f.configPath, pubkey, false)
	if err != nil {
		if len(positional) > 0 && positional[0] == "status" {
			fmt.Fprintf(stdout, "clx %s (config not loadable: %v)\n", Version, err)
			return 0
		}
		fmt.Fprintln(stderr, err)
		return 2
	}

	if cfg.EngineOptions.Silent {
		f.silent = true
	}

	sub := "run"
	subArgs := positional
	if len(positional) > 0 {
		sub = positional[0]
		subArgs = positional[1:]
	}

	switch {
	case f.updateFlag:
		sub = "update"
	case f.uninstallFlag:
		sub = "uninstall"
	case f.cronArgs != nil:
		sub = "cron"
		subArgs = f.cronArgs
	case f.executePrompt != "":
		sub = "execute"
	}

	switch sub {
	case "run":
		exit, err := lifecycle.Run(ctx, lifecycle.Options{
			Config:    cfg,
			ExtraArgs: append(subArgs, passthrough...),
			SkipBoot:  f.skipBoot,
			Minimal:   f.minimal,
			Logger:    logger,
		})
		if err != nil {
			fmt.Fprintln(stderr, "clx run:", err)
		}
		return exit
	case "exec":
		exit, err := claude.Run(ctx, cfg, append(subArgs, passthrough...))
		if err != nil {
			fmt.Fprintln(stderr, "clx exec:", err)
		}
		return exit
	case "execute":
		argv := append([]string{"-p", f.executePrompt}, append(subArgs, passthrough...)...)
		exit, err := lifecycle.Run(ctx, lifecycle.Options{
			Config:    cfg,
			ExtraArgs: argv,
			SkipBoot:  true,
			Logger:    logger,
		})
		if err != nil {
			fmt.Fprintln(stderr, "clx execute:", err)
		}
		return exit
	case "status":
		return cmdStatus(ctx, cfg, stderr, f.minimal)
	case "doctor":
		if err := claude.Doctor(ctx, cfg, stderr); err != nil {
			return 1
		}
		return 0
	case "auth-upload":
		return cmdAuthUpload(ctx, cfg, stdout, stderr)
	case "update":
		if err := update.SelfUpdate(ctx, cfg, logger); err != nil {
			fmt.Fprintln(stderr, "clx update:", err)
			return 1
		}
		fmt.Fprintln(stdout, "clx update: ok")
		return 0
	case "uninstall":
		if err := uninstall.Run(ctx, cfg, stdout, stderr); err != nil {
			fmt.Fprintln(stderr, "clx uninstall:", err)
			return 1
		}
		return 0
	case "cron":
		return cmdCron(ctx, cfg, subArgs, stdout, stderr)
	default:
		// Reserved upstream subcommands (login, logout, mcp, resume, …)
		// passthrough to the real claude binary with the token preserved. The
		// wrapper-owned subcommands above win first; isHelpPassthrough has
		// already caught `--help` variants.
		if reservedClaudeSubcommands[sub] {
			execArgs := append([]string{sub}, append(subArgs, passthrough...)...)
			exit, err := claude.Run(ctx, cfg, execArgs)
			if err != nil {
				fmt.Fprintln(stderr, "clx "+sub+":", err)
			}
			return exit
		}
		fmt.Fprintln(stderr, "clx: unknown subcommand:", sub)
		fmt.Fprintln(stderr, "subcommands: run | status | doctor | auth-upload | exec -- <cmd...>")
		fmt.Fprintln(stderr, "flags: --version | --update | --uninstall | --execute <prompt> | --cron [install|remove] | --silent | --debug | --minimal | --skip-boot")
		return 2
	}
}

// parseFlags pulls flags + positional args out of argv, honouring "--" as
// passthrough sentinel.
//
// Help passthrough is detected first so reserved Claude subcommands like
// `clx mcp --help` route straight to the upstream binary without the wrapper
// rejecting any unknown flags.
func parseFlags(args []string) (flags, []string, []string) {
	var f flags
	if isHelpPassthrough(args) {
		f.helpPassthrough = true
		return f, nil, nil
	}
	var positional, passthrough []string
	consumedDash := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if consumedDash {
			passthrough = append(passthrough, a)
			continue
		}
		switch {
		case a == "--":
			consumedDash = true
		case a == "--version" || a == "-V" || a == "--wrapper-version":
			f.versionFlag = true
		case a == "--update" || a == "-U":
			f.updateFlag = true
		case a == "--uninstall":
			f.uninstallFlag = true
		case a == "--silent":
			f.silent = true
		case a == "--debug" || a == "--verbose":
			f.debug = true
			_ = os.Setenv("CLAUDE_DEBUG", "1")
		case a == "--minimal" || a == "--minimal-output":
			f.minimal = true
		case a == "--skip-boot" || a == "--no-banner":
			f.skipBoot = true
		case a == "-4" || a == "--ipv4":
			f.forceIPv4 = true
			_ = os.Setenv("CLAUDE_FORCE_IPV4", "1")
		case a == "--allow-concurrent-sync":
			f.allowConc = true
		case a == "--cron":
			f.cronArgs = []string{}
			if i+1 < len(args) {
				next := args[i+1]
				if next == "install" || next == "remove" || next == "run" {
					f.cronArgs = []string{next}
					i++
				}
			}
		case a == "--execute":
			if i+1 < len(args) {
				f.executePrompt = args[i+1]
				i++
			}
		case a == "--continue" || a == "-c":
			// Forwarded straight to the upstream `claude` CLI through the
			// normal lifecycle.
			f.continueSession = true
			passthrough = append(passthrough, "--continue")
		case a == "--resume":
			f.resumeSession = ""
			if i+1 < len(args) {
				f.resumeSession = args[i+1]
				passthrough = append(passthrough, "--resume", args[i+1])
				i++
			} else {
				passthrough = append(passthrough, "--resume")
			}
		case strings.HasPrefix(a, "--resume="):
			f.resumeSession = strings.TrimPrefix(a, "--resume=")
			passthrough = append(passthrough, a)
		case a == "--config" && i+1 < len(args):
			f.configPath = args[i+1]
			i++
		case strings.HasPrefix(a, "--config="):
			f.configPath = strings.TrimPrefix(a, "--config=")
		default:
			positional = append(positional, a)
		}
	}
	return f, positional, passthrough
}

func cmdStatus(ctx context.Context, cfg *config.Config, w io.Writer, minimal bool) int {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		fmt.Fprintln(w, "error:", err)
		return 1
	}
	digest, _ := claude.LocalDigest()
	resp, authErr := client.AuthRetrieve(ctx, digest)
	state := summary.Build(ctx, summary.Inputs{Config: cfg, Auth: resp, AuthErr: authErr})
	if minimal {
		ui.PrintMinimalScreen(w, state)
	} else {
		ui.PrintBootScreen(w, state)
	}
	if state.ResultTone == ui.ToneFail {
		return 1
	}
	return 0
}

func cmdAuthUpload(ctx context.Context, cfg *config.Config, stdout, stderr io.Writer) int {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	payload, err := claude.ReadAuth()
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	if err := client.AuthStore(ctx, payload); err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	fmt.Fprintln(stdout, "auth-upload: ok")
	return 0
}

func cmdCron(ctx context.Context, cfg *config.Config, args []string, stdout, stderr io.Writer) int {
	action := "run"
	if len(args) > 0 {
		action = args[0]
	}
	switch action {
	case "install":
		if err := cron.Install(cfg); err != nil {
			fmt.Fprintln(stderr, "clx --cron install:", err)
			return 1
		}
		fmt.Fprintln(stdout, "cron: installed")
		return 0
	case "remove":
		if err := cron.Remove(); err != nil {
			fmt.Fprintln(stderr, "clx --cron remove:", err)
			return 1
		}
		fmt.Fprintln(stdout, "cron: removed")
		return 0
	default:
		if err := cron.Tick(ctx, cfg); err != nil {
			fmt.Fprintln(stderr, "clx --cron:", err)
			return 1
		}
		return 0
	}
}

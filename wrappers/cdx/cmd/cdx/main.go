// cdx — Codex Orchestrator wrapper, engine=codex.
//
// Subcommands: run (default), status, doctor, lane, profile, exec, auth-upload,
// --version, --update, --cron [install|remove|run], --uninstall, --execute.
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

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/log"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/signing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ui"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/uninstall"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/update"
)

// maxRestartDepth caps how many times the wrapper may re-exec itself after a
// self-update before it bails out. Each self-update increments
// CODEX_WRAPPER_RESTART_DEPTH; >2 means the new binary is also asking for
// another update, which is almost certainly a feedback loop.
const maxRestartDepth = 2

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// Parsed flags shared across subcommands.
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
}

// wrapperOwnedSubcommands are subcommand tokens owned by the wrapper itself —
// these must never be re-routed as profile shorthand even if a matching
// [profiles.NAME] section exists in config.toml.
var wrapperOwnedSubcommands = map[string]bool{
	"run":         true,
	"status":      true,
	"doctor":      true,
	"auth-upload": true,
	"lane":        true,
	"profile":     true,
	"update":      true,
	"uninstall":   true,
	"cron":        true,
	"execute":     true,
	"ls":          true,
}

// isProfileShorthand reports whether `sub` is a candidate for the legacy
// `cdx <profile-name>` shorthand: not empty, not a wrapper-owned subcommand,
// and not one of the reserved Codex subcommand names. The caller still has
// to confirm the profile actually exists in config.toml.
func isProfileShorthand(sub string) bool {
	if sub == "" {
		return false
	}
	if wrapperOwnedSubcommands[sub] {
		return false
	}
	if reservedCodexSubcommands[sub] {
		return false
	}
	return true
}

// reservedCodexSubcommands lists the Codex subcommands the wrapper must never
// interpret as profile shorthand and whose `--help` invocations are passed
// straight through to the upstream codex CLI.
var reservedCodexSubcommands = map[string]bool{
	"exec":       true,
	"review":     true,
	"login":      true,
	"logout":     true,
	"mcp":        true,
	"mcp-server": true,
	"app-server": true,
	"completion": true,
	"sandbox":    true,
	"debug":      true,
	"apply":      true,
	"resume":     true,
	"fork":       true,
	"cloud":      true,
	"features":   true,
	"help":       true,
}

// isHelpPassthrough returns true when argv requests upstream Codex help text.
// Matched forms (per legacy fe70ac3:docs/interface-cdx.md):
//   - top-level `--help` / `-h` appearing before any positional token
//   - bare `help` as the first positional token
//   - `<reserved-subcommand> ... --help` / `<reserved-subcommand> ... -h`
//
// The wrapper must not perform any side effects (lock, sync, boot screen) in
// these cases — argv is execed straight into the real codex binary.
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
	// `cdx help` is itself a Codex-recognised help token.
	if firstPositional == "help" {
		return true
	}
	// Top-level `--help` / `-h` with no positional before it.
	if helpBeforePositional {
		return true
	}
	// Reserved-subcommand help (e.g. `cdx exec --help`).
	if firstPositional != "" && reservedCodexSubcommands[firstPositional] {
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
	// Restart-loop guard: each successful self-update increments
	// CODEX_WRAPPER_RESTART_DEPTH and re-execs us. Cap that at maxRestartDepth
	// so a misbehaving server (or a corrupt local binary that keeps reporting
	// itself out-of-date) cannot fork-bomb our way out of the host.
	depth, _ := strconv.Atoi(os.Getenv("CODEX_WRAPPER_RESTART_DEPTH"))
	if depth > maxRestartDepth {
		fmt.Fprintf(stderr, "cdx: restart depth %d exceeded cap %d — refusing to continue\n", depth, maxRestartDepth)
		return 70
	}

	// Snapshot argv before any flag parsing so the update path can re-exec
	// the freshly installed binary with the exact same command the operator
	// originally typed.
	snap := make([]string, len(args))
	copy(snap, args)
	update.SnapshottedArgv = snap

	// Propagate the build-time wrapper version into the cron package so its
	// /cron/check + /cron/report payloads carry the right wrapper_version.
	cron.WrapperVersion = Version

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	f, positional, passthrough := parseFlags(args)

	// Help passthrough bypasses every wrapper side effect: no lock, no sync,
	// no update check, no boot screen, no footer. argv is unmodified.
	if f.helpPassthrough {
		cli, err := codex.FindCLI()
		if err != nil {
			fmt.Fprintln(stderr, "cdx --help:", err)
			return 127
		}
		execArgv := append([]string{cli}, args...)
		if err := syscall.Exec(cli, execArgv, os.Environ()); err != nil {
			fmt.Fprintln(stderr, "cdx --help: exec failed:", err)
			return 127
		}
		// Unreachable: syscall.Exec replaces this process on success.
		return 0
	}

	logger := log.Setup(f.silent || f.debug)

	if f.versionFlag {
		fmt.Fprintf(stdout, "cdx %s (commit %s, built %s, %s/%s)\n", Version, Commit, BuildDate, runtime.GOOS, runtime.GOARCH)
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
			fmt.Fprintf(stdout, "cdx %s (config not loadable: %v)\n", Version, err)
			return 0
		}
		fmt.Fprintln(stderr, err)
		return 2
	}

	// Honour silent flag baked into config too.
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

	// Legacy shorthand: `cdx ls` ↔ `cdx lane spark` — give frequent
	// spark-switchers a one-keystroke path.
	if sub == "ls" {
		sub = "lane"
		subArgs = []string{"spark"}
	}

	// Legacy shorthand: `cdx <profile-name>` dispatches to
	// `codex --profile <name>` when ~/.codex/config.toml has a matching
	// `[profiles.<name>]` section and the token is not one of our internal
	// subcommands. Mirrors fe70ac3:bin/cdx.d/05-main-46-entry.sh.
	if isProfileShorthand(sub) && codex.HasProfile(sub) {
		profileArgs := append([]string{sub}, append(subArgs, passthrough...)...)
		return cmdProfile(ctx, cfg, profileArgs, stderr)
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
			fmt.Fprintln(stderr, "cdx run:", err)
		}
		return exit
	case "exec":
		exit, err := codex.Run(ctx, cfg, append(subArgs, passthrough...))
		if err != nil {
			fmt.Fprintln(stderr, "cdx exec:", err)
		}
		return exit
	case "execute":
		// Headless one-shot via upstream codex exec.
		argv := []string{"--sandbox", "read-only", "-a", "untrusted", "exec", "--skip-git-repo-check", f.executePrompt}
		argv = append(argv, append(subArgs, passthrough...)...)
		exit, err := lifecycle.Run(ctx, lifecycle.Options{
			Config:    cfg,
			ExtraArgs: argv,
			SkipBoot:  true,
			Logger:    logger,
		})
		if err != nil {
			fmt.Fprintln(stderr, "cdx execute:", err)
		}
		return exit
	case "status":
		return cmdStatus(ctx, cfg, stderr, f.minimal)
	case "doctor":
		if err := codex.Doctor(ctx, cfg, stderr); err != nil {
			return 1
		}
		return 0
	case "auth-upload":
		return cmdAuthUpload(ctx, cfg, stdout, stderr)
	case "lane":
		return cmdLane(ctx, cfg, subArgs, stdout, stderr)
	case "profile":
		return cmdProfile(ctx, cfg, append(subArgs, passthrough...), stderr)
	case "update":
		if err := update.SelfUpdate(ctx, cfg, logger); err != nil {
			fmt.Fprintln(stderr, "cdx update:", err)
			return 1
		}
		fmt.Fprintln(stdout, "cdx update: ok")
		return 0
	case "uninstall":
		if err := uninstall.Run(ctx, cfg, stdout, stderr); err != nil {
			fmt.Fprintln(stderr, "cdx uninstall:", err)
			return 1
		}
		return 0
	case "cron":
		return cmdCron(ctx, cfg, subArgs, stdout, stderr)
	default:
		// Reserved upstream subcommands (resume, login, logout, mcp, review, …)
		// passthrough to the real codex binary with the token preserved. The
		// wrapper-owned subcommands above win first; isHelpPassthrough has
		// already caught `--help` variants.
		if reservedCodexSubcommands[sub] {
			execArgs := append([]string{sub}, append(subArgs, passthrough...)...)
			exit, err := codex.Run(ctx, cfg, execArgs)
			if err != nil {
				fmt.Fprintln(stderr, "cdx "+sub+":", err)
			}
			return exit
		}
		fmt.Fprintln(stderr, "cdx: unknown subcommand:", sub)
		fmt.Fprintln(stderr, "subcommands: run | status | doctor | auth-upload | lane <normal|spark|clear> | profile <name> | exec -- <cmd...>")
		fmt.Fprintln(stderr, "flags: --version | --update | --uninstall | --execute <prompt> | --cron [install|remove] | --silent | --debug | --minimal | --skip-boot | -4 | --allow-concurrent-sync")
		return 2
	}
}

// parseFlags pulls flags + positional args out of argv, honouring "--" as
// passthrough sentinel.
//
// Help passthrough is detected first so reserved Codex subcommands like
// `cdx exec --help` route straight to the upstream binary without the wrapper
// rejecting any unknown flags.
func parseFlags(args []string) (flags, []string, []string) {
	var f flags
	if isHelpPassthrough(args) {
		f.helpPassthrough = true
		return f, nil, nil
	}
	var positional []string
	var passthrough []string
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
		case a == "--version" || a == "-V" || a == "--wrapper-version" || a == "-W":
			f.versionFlag = true
		case a == "--update" || a == "-U":
			f.updateFlag = true
		case a == "--uninstall":
			f.uninstallFlag = true
		case a == "--silent":
			f.silent = true
		case a == "--debug" || a == "--verbose":
			f.debug = true
			_ = os.Setenv("CODEX_DEBUG", "1")
		case a == "--minimal" || a == "--minimal-output":
			f.minimal = true
		case a == "--skip-boot" || a == "--no-banner":
			f.skipBoot = true
		case a == "-4" || a == "--ipv4":
			f.forceIPv4 = true
			_ = os.Setenv("CODEX_FORCE_IPV4", "1")
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

// cmdStatus runs auth-retrieve + renders the boot screen.
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
	digest, _ := codex.LocalDigest()
	resp, authErr := client.AuthRetrieve(ctx, digest)
	state := summary.Build(ctx, summary.Inputs{
		Config:  cfg,
		Auth:    resp,
		AuthErr: authErr,
	})
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

func cmdLane(ctx context.Context, cfg *config.Config, args []string, stdout, stderr io.Writer) int {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		fmt.Fprintln(stderr, "lane:", err)
		return 1
	}

	persist := false
	clear := false
	target := ""
	for _, a := range args {
		switch a {
		case "--persist":
			persist = true
		case "clear":
			clear = true
		case "normal", "spark":
			target = a
		}
	}

	if clear && persist {
		if err := client.SetLane(ctx, "normal"); err != nil {
			fmt.Fprintln(stderr, "lane clear:", err)
			return 1
		}
		fmt.Fprintln(stdout, "lane: cleared (server-side preference reset to normal)")
		return 0
	}

	if target == "" {
		lane, err := client.GetLane(ctx)
		if err != nil {
			fmt.Fprintln(stderr, "lane:", err)
			return 1
		}
		fmt.Fprintf(stdout, "» Lane state | effective=%s\n", lane)
		return 0
	}

	if persist {
		if err := client.SetLane(ctx, target); err != nil {
			fmt.Fprintln(stderr, "lane:", err)
			return 1
		}
		fmt.Fprintf(stdout, "lane: %s (persisted)\n", target)
	} else {
		fmt.Fprintf(stdout, "lane: %s (one-shot — not persisted)\n", target)
	}
	return 0
}

func cmdProfile(ctx context.Context, cfg *config.Config, args []string, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: cdx profile <name> [-- codex args...]")
		return 2
	}
	exit, err := codex.Run(ctx, cfg, append([]string{"--profile", args[0]}, args[1:]...))
	if err != nil {
		fmt.Fprintln(stderr, "profile:", err)
	}
	return exit
}

// cmdAuthUpload pushes a locally-edited auth.json to the orchestrator.
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
	payload, err := codex.ReadAuth()
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	// Legacy parity: a vanilla `codex login` auth.json has no `last_refresh`
	// and the orchestrator would reject the POST. Backfill an RFC3339 stamp
	// in-memory so the upload goes through; the server's canonical store
	// rewrites `last_refresh` to its own clock anyway.
	payload, backfilled, err := codex.BackfillLastRefresh(payload)
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	if err := client.AuthStore(ctx, payload); err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	if backfilled {
		fmt.Fprintln(stdout, "auth-upload: ok (last_refresh backfilled)")
	} else {
		fmt.Fprintln(stdout, "auth-upload: ok")
	}
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
			fmt.Fprintln(stderr, "cdx --cron install:", err)
			return 1
		}
		fmt.Fprintln(stdout, "cron: installed")
		return 0
	case "remove":
		if err := cron.Remove(); err != nil {
			fmt.Fprintln(stderr, "cdx --cron remove:", err)
			return 1
		}
		fmt.Fprintln(stdout, "cron: removed")
		return 0
	default:
		// Non-interactive auto-update tick.
		if err := cron.Tick(ctx, cfg); err != nil {
			fmt.Fprintln(stderr, "cdx --cron:", err)
			return 1
		}
		return 0
	}
}

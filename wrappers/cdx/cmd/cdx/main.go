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
	configPath    string
	silent        bool
	debug         bool
	minimal       bool
	skipBoot      bool
	versionFlag   bool
	updateFlag    bool
	uninstallFlag bool
	cronArgs      []string
	executePrompt string
	forceIPv4     bool
	allowConc     bool
}

func run(args []string, stdout, stderr io.Writer) int {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	f, positional, passthrough := parseFlags(args)

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
		fmt.Fprintln(stderr, "cdx: unknown subcommand:", sub)
		fmt.Fprintln(stderr, "subcommands: run | status | doctor | auth-upload | lane <normal|spark|clear> | profile <name> | exec -- <cmd...>")
		fmt.Fprintln(stderr, "flags: --version | --update | --uninstall | --execute <prompt> | --cron [install|remove] | --silent | --debug | --minimal | --skip-boot | -4 | --allow-concurrent-sync")
		return 2
	}
}

// parseFlags pulls flags + positional args out of argv, honouring "--" as
// passthrough sentinel.
func parseFlags(args []string) (flags, []string, []string) {
	var f flags
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
		Config: cfg,
		Auth:   resp,
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
		if err := cron.Install(); err != nil {
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

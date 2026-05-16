// clx — Codex Orchestrator wrapper, engine=claude.
//
// Subcommands: run (default), status, doctor, exec, --version, --update.
// No lane/profile commands (Claude has neither in this orchestrator).
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

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/log"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/signing"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/update"
)

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	var configPath string
	var silent, versionFlag, updateFlag bool
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
		case a == "--version" || a == "-V":
			versionFlag = true
		case a == "--update":
			updateFlag = true
		case a == "--silent":
			silent = true
		case a == "--config" && i+1 < len(args):
			configPath = args[i+1]
			i++
		case strings.HasPrefix(a, "--config="):
			configPath = strings.TrimPrefix(a, "--config=")
		default:
			positional = append(positional, a)
		}
	}

	logger := log.Setup(silent)

	if versionFlag {
		fmt.Fprintf(stdout, "clx %s (commit %s, built %s, %s/%s)\n", Version, Commit, BuildDate, runtime.GOOS, runtime.GOARCH)
		if signing.HasKey() {
			fmt.Fprintln(stdout, "signing pubkey: embedded")
		} else {
			fmt.Fprintln(stdout, "signing pubkey: MISSING (this binary refuses signed configs)")
		}
		return 0
	}

	if configPath == "" {
		configPath = config.DefaultPath()
	}
	pubkey, _ := signing.PublicKey()
	cfg, err := config.Load(configPath, pubkey, false)
	if err != nil {
		if len(positional) > 0 && positional[0] == "status" {
			fmt.Fprintf(stdout, "clx %s (config not loadable: %v)\n", Version, err)
			return 0
		}
		fmt.Fprintln(stderr, err)
		return 2
	}

	sub := "run"
	subArgs := positional
	if len(positional) > 0 {
		sub = positional[0]
		subArgs = positional[1:]
	}
	if updateFlag {
		sub = "update"
	}

	switch sub {
	case "run":
		exit, err := lifecycle.Run(ctx, lifecycle.Options{
			Config:    cfg,
			ExtraArgs: append(subArgs, passthrough...),
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
	case "status":
		return cmdStatus(ctx, cfg, stdout)
	case "doctor":
		err := claude.Doctor(ctx, cfg, stdout)
		if err != nil {
			return 1
		}
		return 0
	case "update":
		if err := update.SelfUpdate(ctx, cfg, logger); err != nil {
			fmt.Fprintln(stderr, "clx update:", err)
			return 1
		}
		fmt.Fprintln(stdout, "clx update: ok")
		return 0
	default:
		fmt.Fprintln(stderr, "clx: unknown subcommand:", sub)
		fmt.Fprintln(stderr, "subcommands: run | status | doctor | exec -- <cmd...> | --version | --update")
		return 2
	}
}

func cmdStatus(ctx context.Context, cfg *config.Config, w io.Writer) int {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		fmt.Fprintln(w, "error:", err)
		return 1
	}
	fmt.Fprintf(w, "clx %s\n", Version)
	fmt.Fprintf(w, "host:        %s (id=%d)\n", cfg.Host.FQDN, cfg.Host.ID)
	fmt.Fprintf(w, "orchestrator: %s\n", cfg.Orchestrator.BaseURL)
	fmt.Fprintf(w, "claude CLI:  %s\n", claude.Version(ctx))
	if status, err := client.SyncStatus(ctx); err == nil {
		fmt.Fprintf(w, "sync:        %s\n", status.Status)
	}
	return 0
}

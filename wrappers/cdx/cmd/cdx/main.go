// cdx — Codex Orchestrator wrapper, engine=codex.
//
// Dispatches one of: run (default), status, doctor, lane, profile, exec,
// --version, --update. The startup sequence for `run` lives in internal/lifecycle.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/log"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/signing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/update"
)

// These get overwritten at build time via -ldflags.
var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run is the testable entry. Returns the process exit code.
func run(args []string, stdout, stderr io.Writer) int {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Strip top-level long flags that apply to all subcommands.
	var configPath string
	var silent bool
	var versionFlag bool
	var updateFlag bool
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
		fmt.Fprintf(stdout, "cdx %s (commit %s, built %s, %s/%s)\n", Version, Commit, BuildDate, runtime.GOOS, runtime.GOARCH)
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
		// status / --version-style commands shouldn't fully fail without config,
		// but every other subcommand needs one.
		if len(positional) > 0 && positional[0] == "status" {
			fmt.Fprintf(stdout, "cdx %s (config not loadable: %v)\n", Version, err)
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
			fmt.Fprintln(stderr, "cdx run:", err)
		}
		return exit
	case "exec":
		exit, err := codex.Run(ctx, cfg, append(subArgs, passthrough...))
		if err != nil {
			fmt.Fprintln(stderr, "cdx exec:", err)
		}
		return exit
	case "status":
		return cmdStatus(ctx, cfg, stdout)
	case "doctor":
		err := codex.Doctor(ctx, cfg, stdout)
		if err != nil {
			return 1
		}
		return 0
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
	default:
		fmt.Fprintln(stderr, "cdx: unknown subcommand:", sub)
		fmt.Fprintln(stderr, "subcommands: run | status | doctor | lane <normal|spark> | profile <name> | exec -- <cmd...> | --version | --update")
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
	fmt.Fprintf(w, "cdx %s\n", Version)
	fmt.Fprintf(w, "host:        %s (id=%d)\n", cfg.Host.FQDN, cfg.Host.ID)
	fmt.Fprintf(w, "orchestrator: %s\n", cfg.Orchestrator.BaseURL)
	fmt.Fprintf(w, "codex CLI:   %s\n", codex.Version(ctx))

	if status, err := client.SyncStatus(ctx); err == nil {
		fmt.Fprintf(w, "sync:        %s\n", status.Status)
	}
	if lane, err := client.GetLane(ctx); err == nil {
		fmt.Fprintf(w, "lane:        %s\n", lane)
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
	if len(args) == 0 {
		lane, err := client.GetLane(ctx)
		if err != nil {
			fmt.Fprintln(stderr, "lane:", err)
			return 1
		}
		fmt.Fprintln(stdout, lane)
		return 0
	}
	if err := client.SetLane(ctx, args[0]); err != nil {
		fmt.Fprintln(stderr, "lane:", err)
		return 1
	}
	fmt.Fprintln(stdout, "lane:", args[0])
	return 0
}

func cmdProfile(ctx context.Context, cfg *config.Config, args []string, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: cdx profile <name>")
		return 2
	}
	// Forward to upstream codex --profile <name>.
	exit, err := codex.Run(ctx, cfg, append([]string{"--profile", args[0]}, args[1:]...))
	if err != nil {
		fmt.Fprintln(stderr, "profile:", err)
	}
	return exit
}

// silence unused-import warning if flag is removed during edits.
var _ = flag.CommandLine

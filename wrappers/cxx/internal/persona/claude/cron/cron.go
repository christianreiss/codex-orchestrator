// Package cron implements the Claude engine tick. Shared host-wide schedule
// ownership lives in internal/cron.
package cron

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	hostcron "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/peer"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/update"
)

const cronPATHEnv = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// WrapperVersion is the running wrapper's semantic version, set from main.go
// via ldflags.
var WrapperVersion = "dev"

// Install and Remove are compatibility adapters. Schedule ownership lives in
// internal/cron so both personas always mutate the same host-wide entry.
func Install(cfg *config.Config) error {
	return hostcron.Install(context.Background(), cfg)
}

func Remove() error {
	return hostcron.Remove(context.Background())
}

// Schedule mutations are indirected so Tick tests never touch a real crontab.
var removeSchedule = func() error { return hostcron.Remove(context.Background()) }

// syncManagedContent converges fleet-managed CLAUDE.md, settings, MCP servers,
// collections and native skills without launching Claude. Indirected for tests.
var syncManagedContent = func(ctx context.Context, cfg *config.Config, minimal bool) error {
	_, err := lifecycle.Run(ctx, lifecycle.Options{
		Config:         cfg,
		SyncOnly:       true,
		Headless:       true,
		SkipBoot:       true,
		Minimal:        minimal,
		WrapperVersion: WrapperVersion,
	})
	return err
}

// Result mirrors the cdx side: it lets cmdCron render a one-line summary of
// what a tick actually did. A no-op tick produces WrapperAction/CodexAction
// == "no_update".
type Result struct {
	WrapperVersion string
	WrapperAction  string
	WrapperTarget  string
	CodexVersion   string
	CodexBefore    string
	CodexAction    string
	CodexTarget    string
	SyncAction     string // "" when managed content converged | "failed"
	Reported       bool
}

// Tick is the action taken by `clx --cron run`.
func Tick(ctx context.Context, cfg *config.Config) (Result, error) {
	return TickWithOptions(ctx, cfg, false)
}

// TickWithOptions is Tick with presentation state carried through unattended
// self/peer updates. Minimal mode stays portable even after a re-exec.
func TickWithOptions(ctx context.Context, cfg *config.Config, minimal bool) (Result, error) {
	logger := slog.Default()
	ensureCronPath()
	res := Result{
		WrapperVersion: WrapperVersion,
		WrapperAction:  "no_update",
		CodexAction:    "no_update",
	}
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
		Logger:        logger,
	})
	if err != nil {
		return res, err
	}

	claudeVer := strings.TrimSpace(claude.Version(ctx))
	res.CodexBefore = claudeVer
	res.CodexVersion = claudeVer
	check, err := client.CronCheck(ctx, orchestrator.CronCheckRequest{
		Engine:         "claude",
		ClientVersion:  claudeVer,
		WrapperVersion: WrapperVersion,
	})
	if err != nil {
		return res, fmt.Errorf("cron check: %w", err)
	}

	if check.Action == "disable" {
		logger.Info("cron: auto-update disabled by server; removing cron job")
		if err := removeSchedule(); err != nil {
			logger.Warn("cron: failed to fully remove cron job", "err", err)
		}
		res.WrapperAction = "disable"
		res.CodexAction = "disable"
		return res, nil
	}

	if check.Wrapper != nil && check.Wrapper.Action == "update" {
		if os.Getenv("CLAUDE_WRAPPER_RESTARTED") == "1" {
			return res, fmt.Errorf("cron: wrapper update loop detected for target %s", check.Wrapper.TargetVersion)
		}
		if check.Wrapper.URL == "" || check.Wrapper.SHA256 == "" || check.Wrapper.TargetVersion == "" {
			return res, fmt.Errorf("cron: wrapper update requested but metadata incomplete (%+v)", check.Wrapper)
		}
		if !claude.SemverGT(check.Wrapper.TargetVersion, WrapperVersion) {
			logger.Warn("cron: skipping wrapper downgrade", "current", WrapperVersion, "target", check.Wrapper.TargetVersion)
		} else {
			downloadURL := resolveURL(cfg.Orchestrator.BaseURL, check.Wrapper.URL)
			exe, err := update.SelfUpdateFrom(ctx, cfg, downloadURL, check.Wrapper.SHA256, check.Wrapper.TargetVersion, logger)
			if err != nil {
				return res, fmt.Errorf("cron: wrapper self-update: %w", err)
			}
			logger.Info("cron: wrapper updated; re-exec'ing", "target", check.Wrapper.TargetVersion)
			res.WrapperAction = "updated"
			res.WrapperTarget = check.Wrapper.TargetVersion
			reexecArgs := []string{"--cron", "run"}
			if minimal {
				reexecArgs = append(reexecArgs, "--minimal")
			}
			if err := update.ReExecAfterUpdate(exe, reexecArgs); err != nil {
				return res, fmt.Errorf("cron: re-exec after wrapper update: %w", err)
			}
			return res, nil
		}
	}

	targetClient := check.TargetVersion
	if targetClient == "" {
		targetClient = check.ClientVersion
	}
	if check.Action == "update" && targetClient != "" {
		logger.Info("cron: Claude update", "from", claudeVer, "to", targetClient, "enforce_exact", check.EnforceExact)
		res.CodexAction = "updated"
		res.CodexTarget = targetClient
		if err := claude.EnsureClaude(ctx, targetClient, check.EnforceExact, logger); err != nil {
			return res, fmt.Errorf("cron: claude update: %w", err)
		}
	}
	if err := claude.EnsureShellAliases(); err != nil {
		logger.Warn("cron: ensureShellAliases", "err", err)
	}

	// Converge fleet-managed content. Without this an idle host — one where
	// nobody ever starts a session — drifts from fleet config indefinitely,
	// since bootstrap otherwise only runs on a launch. Placed after the
	// wrapper-update branch above, which either returns or execs, so a sync
	// never runs with pre-update code. Best-effort like every other content
	// step here: an auth-refused host must not turn the whole tick red.
	if err := syncManagedContent(ctx, cfg, minimal); err != nil {
		logger.Warn("cron: managed content sync skipped", "err", err)
		res.SyncAction = "failed"
	}

	// Keep the peer wrapper + engine current too: a dual-engine host must have
	// all four components (clx, cdx, claude, codex) updated by a single cron
	// entry. EnsureForCron no-ops when this tick was itself spawned by the
	// peer (CODEX_ORCH_PEER_SPAWN=1) or when the host has no peer engine.
	if !hostcron.IsCoordinated() {
		peer.EnsureForCron(ctx, cfg, minimal, logger)
	}

	newVer := strings.TrimSpace(claude.Version(ctx))
	res.CodexVersion = newVer
	report := orchestrator.CronReportRequest{
		Engine:         "claude",
		ClientVersion:  newVer,
		WrapperVersion: WrapperVersion,
	}
	var reportErr error
	for attempt := 1; attempt <= 2; attempt++ {
		reportErr = client.CronReport(ctx, report)
		if reportErr == nil {
			res.Reported = true
			return res, nil
		}
		logger.Warn("cron: /cron/report attempt failed", "attempt", attempt, "err", reportErr)
		if attempt < 2 {
			select {
			case <-ctx.Done():
				return res, ctx.Err()
			case <-time.After(2 * time.Second):
			}
		}
	}
	return res, fmt.Errorf("cron: /cron/report failed after retry: %w", reportErr)
}

func ensureCronPath() {
	current := os.Getenv("PATH")
	if current == "" {
		_ = os.Setenv("PATH", strings.TrimPrefix(cronPATHEnv, "PATH="))
		return
	}
	parts := strings.Split(current, ":")
	have := make(map[string]struct{}, len(parts))
	for _, p := range parts {
		have[p] = struct{}{}
	}
	add := make([]string, 0, 2)
	for _, p := range []string{"/usr/local/sbin", "/usr/local/bin"} {
		if _, ok := have[p]; !ok {
			add = append(add, p)
		}
	}
	if len(add) == 0 {
		return
	}
	_ = os.Setenv("PATH", strings.Join(append(add, current), ":"))
}

func resolveURL(base, abs string) string {
	if strings.HasPrefix(abs, "http://") || strings.HasPrefix(abs, "https://") {
		return abs
	}
	base = strings.TrimRight(base, "/")
	if !strings.HasPrefix(abs, "/") {
		abs = "/" + abs
	}
	return base + abs
}

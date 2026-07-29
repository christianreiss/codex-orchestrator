// Package cron implements the Codex engine maintenance tick. The shared cxx
// coordinator owns the one host-wide schedule and invokes this tick once.
package cron

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	hostcron "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/peer"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/update"
)

// Indirected for tests.
var removeSchedule = func() error { return hostcron.Remove(context.Background()) }

const cronPATHEnv = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// WrapperVersion is the running wrapper's semantic version, set from main.go
// via ldflags. The cron Tick path sends it in CronCheck/CronReport so the
// server can decide whether a wrapper update is needed.
var WrapperVersion = "dev"

// Install and Remove are compatibility adapters. Schedule ownership lives in
// internal/cron so both personas always mutate the same host-wide entry.
func Install(cfg *config.Config) error {
	return hostcron.Install(context.Background(), cfg)
}

func Remove() error {
	return hostcron.Remove(context.Background())
}

// Result summarises what a Tick did so callers can render a human-readable
// status line. All fields are zero-safe — a no-op tick produces a Result with
// WrapperAction/CodexAction == "no_update" and no error.
type Result struct {
	WrapperVersion string // version before the tick
	WrapperAction  string // "no_update" | "updated" | "disable"
	WrapperTarget  string // target version if updated
	CodexVersion   string // version after the tick (post-update)
	CodexBefore    string // version before the tick
	CodexAction    string // "no_update" | "updated"
	CodexTarget    string // target version if updated
	Reported       bool   // /cron/report succeeded
}

// Tick is the action taken by `cdx --cron run`. It checks the orchestrator,
// applies any wrapper self-update (re-exec'ing into the new binary), then
// applies any Codex update, and finally reports the post-update versions
// back via /cron/report. A second /cron/report attempt is made on the first
// failure; persistent failure returns an error so callers can exit non-zero.
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

	codexVer := strings.TrimSpace(codex.Version(ctx))
	res.CodexBefore = codexVer
	res.CodexVersion = codexVer
	check, err := client.CronCheck(ctx, orchestrator.CronCheckRequest{
		Engine:         "codex",
		ClientVersion:  codexVer,
		WrapperVersion: WrapperVersion,
	})
	if err != nil {
		return res, fmt.Errorf("cron check: %w", err)
	}

	if check.Action == "disable" {
		logger.Info("cron: auto-update disabled by server; removing cron job")
		_ = removeSchedule()
		res.WrapperAction = "disable"
		res.CodexAction = "disable"
		return res, nil
	}

	// Wrapper self-update first: if the server wants us on a newer wrapper,
	// download/verify/swap/re-exec before touching the Codex CLI. The re-exec
	// guarantees the second pass runs with the freshly installed code.
	if check.Wrapper != nil && check.Wrapper.Action == "update" {
		if os.Getenv("CODEX_WRAPPER_RESTARTED") == "1" {
			return res, fmt.Errorf("cron: wrapper update loop detected for target %s", check.Wrapper.TargetVersion)
		}
		if check.Wrapper.URL == "" || check.Wrapper.SHA256 == "" || check.Wrapper.TargetVersion == "" {
			return res, fmt.Errorf("cron: wrapper update requested but metadata incomplete (%+v)", check.Wrapper)
		}
		if !codex.SemverGT(check.Wrapper.TargetVersion, WrapperVersion) {
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
			// syscall.Exec replaces the process, so reaching this point means it
			// returned an error — treated as a hard failure above.
			return res, nil
		}
	}

	// Codex CLI install/update. Server signals via top-level `action=update` +
	// `target_version`. We honour both: if there's a target, ensure it; if the
	// top-level action is no_update we still pass-through Version() and let
	// EnsureCodex short-circuit when current matches.
	targetClient := check.TargetVersion
	if targetClient == "" {
		targetClient = check.ClientVersion
	}
	if check.Action == "update" && targetClient != "" {
		logger.Info("cron: Codex update", "from", codexVer, "to", targetClient, "enforce_exact", check.EnforceExact)
		res.CodexAction = "updated"
		res.CodexTarget = targetClient
		if err := codex.EnsureCodex(ctx, targetClient, check.EnforceExact, logger); err != nil {
			return res, fmt.Errorf("cron: codex update: %w", err)
		}
	}
	if err := codex.EnsureShellAliases(); err != nil {
		logger.Warn("cron: ensureShellAliases", "err", err)
	}

	// Keep the peer wrapper + engine current too: a dual-engine host must have
	// all four components (cdx, clx, codex, claude) updated by a single cron
	// entry. EnsureForCron no-ops when this tick was itself spawned by the
	// peer (CODEX_ORCH_PEER_SPAWN=1) or when the host has no peer engine.
	if !hostcron.IsCoordinated() {
		peer.EnsureForCron(ctx, cfg, minimal, logger)
	}

	// Re-read codex version (it may have changed) for the report.
	newCodexVer := strings.TrimSpace(codex.Version(ctx))
	res.CodexVersion = newCodexVer

	report := orchestrator.CronReportRequest{
		Engine:         "codex",
		ClientVersion:  newCodexVer,
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

// resolveURL returns abs when it already has a scheme; otherwise it prefixes
// abs with the configured orchestrator base URL.
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

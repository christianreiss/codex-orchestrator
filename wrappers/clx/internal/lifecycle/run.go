// Package lifecycle orchestrates the startup sequence for a single `clx run`:
// lock → auth-sync → resource-sync → boot screen → exec → usage report →
// exit footer.
package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
)

type Options struct {
	Config       *config.Config
	ExtraArgs    []string
	SkipAuthSync bool
	SkipBoot     bool
	Minimal      bool
	Logger       *slog.Logger
}

func Run(ctx context.Context, opts Options) (int, error) {
	cfg := opts.Config
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	concurrent := false
	lock, err := ipc.Acquire("clx")
	if err != nil {
		if !errors.Is(err, ipc.ErrHeld) {
			return 1, err
		}
		concurrent = true
		fmt.Fprintln(os.Stderr, "clx: another instance is already running — entering read-only mode")
	} else {
		defer lock.Release()
	}

	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
		Logger:        logger,
	})
	if err != nil {
		return 1, err
	}

	var authResp *orchestrator.AuthRetrieveResponse
	var authErr error
	authSynced := false
	if !opts.SkipAuthSync {
		authResp, authErr, authSynced = syncAuth(ctx, client, logger, concurrent)
		if authErr != nil {
			logger.Warn("auth sync failed; continuing with whatever is on disk", "err", authErr)
		}
	}

	maybeEnsureClaude(ctx, authResp, concurrent, logger)

	var agentsUpdated, configUpdated bool
	if !concurrent {
		agentsUpdated, configUpdated = syncResources(ctx, client, logger)
	}

	if !opts.SkipBoot {
		state := summary.Build(ctx, summary.Inputs{
			Config:        cfg,
			Auth:          authResp,
			AuthErr:       authErr,
			Concurrent:    concurrent,
			AgentsUpdated: agentsUpdated,
			ConfigUpdated: configUpdated,
			AuthSynced:    authSynced,
		})
		if opts.Minimal {
			ui.PrintMinimalScreen(os.Stderr, state)
		} else {
			ui.PrintBootScreen(os.Stderr, state)
		}
	}

	started := time.Now()
	exitCode, runErr := claude.Run(ctx, cfg, opts.ExtraArgs)
	duration := time.Since(started)

	usageResult, usageTone := reportUsage(client, cfg, duration, exitCode, logger)

	if !opts.SkipBoot {
		caps := ui.DetectCaps(themeFromConfig(cfg))
		fmt.Fprintln(os.Stderr)
		ui.PrintExitFooter(os.Stderr, caps, "clx", ui.ExitFooter{
			When:        time.Now(),
			HeaderText:  "Run summary",
			RunDuration: duration,
			UsageStatus: usageResult,
			UsageTone:   usageTone,
			AuthStatus:  "not-needed",
			AuthTone:    ui.ToneOK,
		})
	}

	return exitCode, runErr
}

func syncAuth(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, concurrent bool) (*orchestrator.AuthRetrieveResponse, error, bool) {
	digest, err := claude.LocalDigest()
	if err != nil {
		return nil, err, false
	}
	resp, err := client.AuthRetrieve(ctx, digest)
	if err != nil {
		return nil, err, false
	}
	switch strings.ToLower(resp.Status) {
	case "current", "ok", "valid", "unchanged", "":
		return resp, nil, false
	case "outdated", "updated", "missing":
		if concurrent {
			return resp, nil, false
		}
		if len(resp.Auth) == 0 {
			return resp, errors.New("server reports outdated but did not return a payload"), false
		}
		if err := claude.WriteAuth(resp.Auth); err != nil {
			return resp, err, false
		}
		logger.Info("credentials.json updated from orchestrator")
		return resp, nil, true
	case "upload_required":
		return resp, errors.New("server requires auth upload — run `clx auth-upload`"), false
	default:
		return resp, fmt.Errorf("unknown status %q", resp.Status), false
	}
}

func syncResources(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) (agents, conf bool) {
	syncCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		u, err := writeAgents(syncCtx, client)
		if err != nil {
			logger.Debug("agents sync skipped", "err", err)
		}
		agents = u
	}()
	go func() {
		defer wg.Done()
		u, err := writeSettings(syncCtx, client)
		if err != nil {
			logger.Debug("config sync skipped", "err", err)
		}
		conf = u
	}()
	wg.Wait()
	return
}

func writeAgents(ctx context.Context, client *orchestrator.Client) (bool, error) {
	home, _ := os.UserHomeDir()
	dst := filepath.Join(home, ".claude", "CLAUDE.md")
	digest := fileDigest(dst)
	body, err := client.RetrieveAgents(ctx, digest)
	if err != nil {
		return false, err
	}
	if len(body) == 0 {
		return false, nil
	}
	return true, atomicWrite(dst, body, 0o644)
}

func writeSettings(ctx context.Context, client *orchestrator.Client) (bool, error) {
	home, _ := os.UserHomeDir()
	dst := filepath.Join(home, ".claude", "settings.json")
	digest := fileDigest(dst)
	body, err := client.RetrieveConfig(ctx, digest)
	if err != nil {
		return false, err
	}
	if len(body) == 0 {
		return false, nil
	}
	return true, atomicWrite(dst, body, 0o644)
}

func atomicWrite(path string, body []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".new"
	if err := os.WriteFile(tmp, body, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func fileDigest(p string) string {
	raw, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func reportUsage(client *orchestrator.Client, cfg *config.Config, dur time.Duration, exit int, logger *slog.Logger) (string, ui.Tone) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	model := ""
	if cfg.EngineOptions.ClaudeModelOverride != nil {
		model = *cfg.EngineOptions.ClaudeModelOverride
	}
	if err := client.PostUsage(ctx, orchestrator.UsageRecord{
		Engine:          "claude",
		Model:           model,
		DurationSeconds: dur.Seconds(),
	}); err != nil {
		logger.Debug("usage report failed", "err", err, "exit", exit)
		return "skipped (" + err.Error() + ")", ui.ToneWarn
	}
	return "uploaded", ui.ToneOK
}

func themeFromConfig(cfg *config.Config) string {
	if cfg == nil || cfg.EngineOptions.AdminThemeHint == nil {
		return ""
	}
	return *cfg.EngineOptions.AdminThemeHint
}

// maybeEnsureClaude repairs the local Claude CLI when the orchestrator
// reports auto-update enabled and the local version differs from target.
// Failures are logged but never block launch.
func maybeEnsureClaude(ctx context.Context, auth *orchestrator.AuthRetrieveResponse, concurrent bool, logger *slog.Logger) {
	if concurrent || auth == nil || auth.Versions == nil {
		return
	}
	v := auth.Versions
	if !v.AutoUpdateEnabled {
		return
	}
	if v.ClientVersion == nil || *v.ClientVersion == "" {
		return
	}
	target := *v.ClientVersion
	if v.ClientVersionOverride != nil && *v.ClientVersionOverride != "" {
		target = *v.ClientVersionOverride
	}
	current := strings.TrimSpace(claude.Version(ctx))
	if current == target {
		return
	}
	if err := claude.EnsureClaude(ctx, target, v.ClientVersionEnforceExact, logger); err != nil {
		logger.Warn("claude auto-update skipped", "err", err, "target", target, "current", current)
	}
}

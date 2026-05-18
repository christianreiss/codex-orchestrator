// Package lifecycle orchestrates the startup sequence for a single `cdx run`:
// lock → version-check → auth-sync → resource-sync → exec → usage report.
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
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
)

type Options struct {
	Config       *config.Config
	ExtraArgs    []string
	SkipAuthSync bool
	Logger       *slog.Logger
}

// Run executes one full Codex session and returns the upstream exit code.
func Run(ctx context.Context, opts Options) (int, error) {
	cfg := opts.Config
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	lock, err := ipc.Acquire("cdx")
	if err != nil {
		if errors.Is(err, ipc.ErrHeld) {
			fmt.Fprintln(os.Stderr, "cdx: another instance is already running")
			return 1, err
		}
		return 1, err
	}
	defer lock.Release()

	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
		Logger:        logger,
	})
	if err != nil {
		return 1, err
	}

	if !opts.SkipAuthSync {
		if err := syncAuth(ctx, client, logger); err != nil {
			logger.Warn("auth sync failed; continuing with whatever is on disk", "err", err)
		}
	}

	syncResources(ctx, client, logger)

	started := time.Now()
	exitCode, runErr := codex.Run(ctx, cfg, opts.ExtraArgs)
	duration := time.Since(started)

	go reportUsage(client, cfg, duration, exitCode, logger)

	return exitCode, runErr
}

func syncAuth(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) error {
	digest, err := codex.LocalDigest()
	if err != nil {
		return fmt.Errorf("local digest: %w", err)
	}
	resp, err := client.AuthRetrieve(ctx, digest)
	if err != nil {
		return err
	}
	switch resp.Status {
	case "current", "ok", "valid", "unchanged", "":
		return nil
	case "outdated", "missing":
		if len(resp.Auth) == 0 {
			return errors.New("server reports outdated but did not return a payload")
		}
		if err := codex.WriteAuth(resp.Auth); err != nil {
			return err
		}
		logger.Info("auth.json updated from orchestrator")
		return nil
	default:
		return fmt.Errorf("unknown auth status %q", resp.Status)
	}
}

// syncResources fetches the agents document and config.toml in parallel with
// a 10-second cap. Failures are logged but never block the foreground exec.
func syncResources(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) {
	syncCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		if err := writeAgents(syncCtx, client); err != nil {
			logger.Debug("agents sync skipped", "err", err)
		}
	}()
	go func() {
		defer wg.Done()
		if err := writeConfigToml(syncCtx, client); err != nil {
			logger.Debug("config sync skipped", "err", err)
		}
	}()

	wg.Wait()
}

func writeAgents(ctx context.Context, client *orchestrator.Client) error {
	home, _ := os.UserHomeDir()
	dst := filepath.Join(home, ".codex", "AGENTS.md")
	digest := fileDigest(dst)
	body, err := client.RetrieveAgents(ctx, digest)
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return nil
	}
	return atomicWrite(dst, body, 0o644)
}

func writeConfigToml(ctx context.Context, client *orchestrator.Client) error {
	home, _ := os.UserHomeDir()
	dst := filepath.Join(home, ".codex", "config.toml")
	digest := fileDigest(dst)
	body, err := client.RetrieveConfig(ctx, digest)
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return nil
	}
	return atomicWrite(dst, body, 0o644)
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

func reportUsage(client *orchestrator.Client, cfg *config.Config, dur time.Duration, exit int, logger *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	model := ""
	if cfg.EngineOptions.ModelOverride != nil {
		model = *cfg.EngineOptions.ModelOverride
	}
	if err := client.PostUsage(ctx, orchestrator.UsageRecord{
		Engine:          "codex",
		Model:           model,
		DurationSeconds: dur.Seconds(),
	}); err != nil {
		logger.Debug("usage report failed", "err", err, "exit", exit)
	}
}

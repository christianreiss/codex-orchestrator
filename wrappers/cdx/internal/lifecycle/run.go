// Package lifecycle orchestrates the startup sequence for a single `cdx run`:
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

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ui"
)

type Options struct {
	Config       *config.Config
	ExtraArgs    []string
	SkipAuthSync bool
	SkipBoot     bool
	Minimal      bool
	Logger       *slog.Logger
}

// Run executes one full Codex session and returns the upstream exit code.
func Run(ctx context.Context, opts Options) (int, error) {
	cfg := opts.Config
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	// Concurrent-instance detection. If another instance holds the lock we
	// fall back to a read-only mode so the boot screen still shows fresh quota.
	concurrent := false
	lock, err := ipc.Acquire("cdx")
	if err != nil {
		if !errors.Is(err, ipc.ErrHeld) {
			return 1, err
		}
		concurrent = true
		fmt.Fprintln(os.Stderr, "cdx: another instance is already running — entering read-only mode")
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

	var skillsUpdated, agentsUpdated, configUpdated bool
	if !concurrent {
		skillsUpdated, agentsUpdated, configUpdated = syncResources(ctx, client, logger)
	}

	// Boot screen.
	if !opts.SkipBoot {
		state := summary.Build(ctx, summary.Inputs{
			Config:        cfg,
			Auth:          authResp,
			AuthErr:       authErr,
			Concurrent:    concurrent,
			SkillsUpdated: skillsUpdated,
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

	// Block launch if hard-fail quota.
	if authResp != nil && authResp.QuotaHardFail && authResp.ChatGPT != nil {
		state := summary.Build(ctx, summary.Inputs{Config: cfg, Auth: authResp})
		if state.QuotaBlock != "" {
			return 1, fmt.Errorf("launch refused: %s", state.QuotaBlock)
		}
	}

	started := time.Now()
	exitCode, runErr := codex.Run(ctx, cfg, opts.ExtraArgs)
	duration := time.Since(started)

	usageResult, usageTone := reportUsage(client, cfg, duration, exitCode, logger)

	// Exit footer.
	if !opts.SkipBoot {
		caps := ui.DetectCaps(themeFromConfig(cfg))
		fmt.Fprintln(os.Stderr)
		ui.PrintExitFooter(os.Stderr, caps, "cdx", ui.ExitFooter{
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
	digest, err := codex.LocalDigest()
	if err != nil {
		return nil, fmt.Errorf("local digest: %w", err), false
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
			logger.Info("auth update skipped (concurrent mode)", "status", resp.Status)
			return resp, nil, false
		}
		if len(resp.Auth) == 0 {
			return resp, errors.New("server reports outdated but did not return a payload"), false
		}
		if err := codex.WriteAuth(resp.Auth); err != nil {
			return resp, err, false
		}
		logger.Info("auth.json updated from orchestrator")
		return resp, nil, true
	case "upload_required":
		return resp, errors.New("server requires auth upload — run `cdx auth-upload`"), false
	default:
		return resp, fmt.Errorf("unknown auth status %q", resp.Status), false
	}
}

// syncResources fetches the agents document and config.toml in parallel with
// a 10-second cap. Returns whether each was actually updated this run.
func syncResources(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) (skills, agents, conf bool) {
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
		u, err := writeConfigToml(syncCtx, client)
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
	dst := filepath.Join(home, ".codex", "AGENTS.md")
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

func writeConfigToml(ctx context.Context, client *orchestrator.Client) (bool, error) {
	home, _ := os.UserHomeDir()
	dst := filepath.Join(home, ".codex", "config.toml")
	digest := fileDigest(dst)
	body, err := client.RetrieveConfig(ctx, digest)
	if err != nil {
		return false, err
	}
	if len(body) == 0 {
		return false, nil
	}
	if err := atomicWrite(dst, body, 0o644); err != nil {
		return false, err
	}
	return true, nil
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
	if cfg.EngineOptions.ModelOverride != nil {
		model = *cfg.EngineOptions.ModelOverride
	}
	if err := client.PostUsage(ctx, orchestrator.UsageRecord{
		Engine:          "codex",
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

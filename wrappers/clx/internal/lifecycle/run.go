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
	"regexp"
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
	exitCode, captured, runErr := claude.RunCapture(ctx, cfg, opts.ExtraArgs)
	duration := time.Since(started)

	usageResult, usageTone := reportUsage(client, cfg, started, duration, captured, exitCode, logger)

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

// reportUsage extracts Claude usage (pipe-mode capture first, then JSONL
// session-file discovery under ~/.claude/projects and ~/.claude) and POSTs
// the legacy `{engine,fqdn,usages:[…]}` batch to /usage. Best-effort: any
// failure surfaces in the exit footer but never blocks the foreground exec.
func reportUsage(client *orchestrator.Client, cfg *config.Config, started time.Time, dur time.Duration, captured []byte, exit int, logger *slog.Logger) (string, ui.Tone) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	model := ""
	if cfg.EngineOptions.ClaudeModelOverride != nil {
		model = *cfg.EngineOptions.ClaudeModelOverride
	}

	var tokens claude.Tokens
	var line string
	if len(captured) > 0 {
		if t, ok := claude.ParseStdoutCapture(captured); ok {
			tokens = t
			line = extractUsageLine(captured)
		}
	}
	if tokens.IsZero() {
		roots := claude.DefaultSessionRoots()
		files, _ := claude.DiscoverSessions(roots, started)
		for _, f := range files {
			if t, err := claude.ParseSessionJSONL(f); err == nil {
				tokens.Add(t)
			}
		}
	}

	entry := orchestrator.UsageEntry{
		Model:         model,
		Total:         tokens.Total,
		Input:         tokens.Input,
		Output:        tokens.Output,
		Cached:        tokens.Cached,
		CacheCreation: tokens.CacheCreation,
		Duration:      dur.Seconds(),
		Line:          line,
	}
	batch := orchestrator.UsagesBatch{
		Engine: "claude",
		FQDN:   cfg.Host.FQDN,
		Usages: []orchestrator.UsageEntry{entry},
	}
	if err := client.PostUsages(ctx, batch); err != nil {
		logger.Debug("usage report failed", "err", err, "exit", exit)
		return "skipped (" + err.Error() + ")", ui.ToneWarn
	}
	if tokens.IsZero() {
		return "uploaded (no tokens detected)", ui.ToneOK
	}
	return "uploaded", ui.ToneOK
}

// extractUsageLine pulls the literal "Token usage: …" footer line from the
// captured stdout buffer so the server-side audit log shows the upstream
// phrasing. Strips ANSI/control bytes to match the legacy bash payload.
func extractUsageLine(buf []byte) string {
	if len(buf) == 0 {
		return ""
	}
	s := lineStripper.ReplaceAllString(string(buf), "")
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if strings.Contains(strings.ToLower(line), "token usage") {
			if len(line) > 240 {
				return line[:240] + "…"
			}
			return line
		}
	}
	return ""
}

// lineStripper is a cheap one-shot noise filter for log lines.
var lineStripper = regexp.MustCompile(`\x1B\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`)

func themeFromConfig(cfg *config.Config) string {
	if cfg == nil || cfg.EngineOptions.AdminThemeHint == nil {
		return ""
	}
	return *cfg.EngineOptions.AdminThemeHint
}

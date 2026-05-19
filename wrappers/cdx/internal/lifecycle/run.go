// Package lifecycle orchestrates the startup sequence for a single `cdx run`:
// lock → bundle (auth + agents + config in one POST) → decide → boot screen →
// pre-exec → Codex → post-exec auth upload → usage report → exit footer.
package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/user"
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

// localProbe is the cached LocalAuthProbe binding to the codex package
// helpers; lets orchestrator.Decide work without importing codex.
var localProbe = orchestrator.LocalAuthProbe{
	IsValid: codex.IsValidLocalAuth,
	IsFresh: codex.IsFresh,
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

	authPath, _ := codex.AuthPath()

	var (
		authResp      *orchestrator.AuthRetrieveResponse
		authErr       error
		authSynced    bool
		agentsUpdated bool
		configUpdated bool
		skillsUpdated bool
		dec           orchestrator.AuthDecision
	)

	if !opts.SkipAuthSync {
		authResp, authErr, authSynced, agentsUpdated, configUpdated = bootstrap(ctx, client, logger, concurrent, authPath)
		dec = orchestrator.Decide(authResp, authPath, cfg.Host.Secure, localProbe)

		// Insecure-host approval polling — block here until status flips or
		// the operator aborts. Re-bundle once on resolution.
		if dec.NeedsApprovalPoll {
			logger.Warn("auth status insecure; opening approval-pending box")
			resolved, perr := ui.PollApproval(ctx, client, 5*time.Second)
			if perr != nil && !errors.Is(perr, context.Canceled) {
				logger.Warn("approval poll failed", "err", perr)
			}
			if resolved {
				authResp, authErr, authSynced, agentsUpdated, configUpdated = bootstrap(ctx, client, logger, concurrent, authPath)
				dec = orchestrator.Decide(authResp, authPath, cfg.Host.Secure, localProbe)
			}
		}

		// On missing/upload_required, push the local file via /sync/bootstrap
		// auth_candidate and re-decide.
		if dec.Allowed && (dec.Status == "missing" || dec.Status == "upload_required") {
			if raw, rerr := codex.ReadAuth(); rerr == nil && len(raw) > 0 {
				if err := pushAuthCandidate(ctx, client, raw); err != nil {
					logger.Warn("auth-candidate upload failed", "err", err)
				} else {
					authResp, authErr, authSynced, agentsUpdated, configUpdated = bootstrap(ctx, client, logger, concurrent, authPath)
					dec = orchestrator.Decide(authResp, authPath, cfg.Host.Secure, localProbe)
				}
			}
		}
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
		if !dec.Allowed && dec.Reason != "" {
			state.ResultLabel = dec.Reason
			state.ResultTone = ui.ToneFail
		}
		if opts.Minimal {
			ui.PrintMinimalScreen(os.Stderr, state)
		} else {
			ui.PrintBootScreen(os.Stderr, state)
		}
	}

	// Refuse launch on auth decision.
	if !opts.SkipAuthSync && !dec.Allowed {
		return 1, fmt.Errorf("launch refused: %s", dec.Reason)
	}

	// Block launch if hard-fail quota.
	if authResp != nil && authResp.QuotaHardFail && authResp.ChatGPT != nil {
		state := summary.Build(ctx, summary.Inputs{Config: cfg, Auth: authResp})
		if state.QuotaBlock != "" {
			return 1, fmt.Errorf("launch refused: %s", state.QuotaBlock)
		}
	}

	// Snapshot local auth before the run so we can detect post-run rotation.
	beforeHash, beforeRefresh := snapshotAuth(authPath)

	started := time.Now()
	exitCode, runErr := codex.Run(ctx, cfg, opts.ExtraArgs)
	duration := time.Since(started)

	// Post-exec auth upload (best-effort, 5s budget). A `codex login` mid-run
	// rotates tokens; we want to push the rotated payload to canonical store.
	maybePostRunAuthUpload(client, logger, authPath, beforeHash, beforeRefresh)

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

// bootstrap tries SyncBootstrap first and, on 404/501, falls back to the
// per-resource pulls. Returns the same tuple regardless of which path ran.
func bootstrap(
	ctx context.Context, client *orchestrator.Client, logger *slog.Logger,
	concurrent bool, authPath string,
) (*orchestrator.AuthRetrieveResponse, error, bool, bool, bool) {
	digest, _ := codex.LocalDigest()

	agentsDigest := fileDigest(agentsPath())
	configDigest := fileDigest(configTomlPath())

	var candidate []byte
	// On the offline-retry path we don't have an auth response yet; sending the
	// candidate up-front is safe (server only acts on it for missing/upload).
	if raw, err := codex.ReadAuth(); err == nil {
		candidate = raw
	}

	username := ""
	home := ""
	if u, err := user.Current(); err == nil && u != nil {
		username = u.Username
	}
	if h, err := os.UserHomeDir(); err == nil {
		home = h
	}

	bctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	resp, berr := client.SyncBootstrap(bctx, orchestrator.BundleRequest{
		Engine:        "codex",
		IncludeAuth:   true,
		AuthDigest:    digest,
		AuthCandidate: candidate,
		Agents:        agentsDigest,
		Config:        configDigest,
		Home:          home,
		Username:      username,
	})

	if berr != nil && isBundleUnsupported(berr) {
		logger.Debug("bundle endpoint unsupported, falling back to per-resource pulls", "err", berr)
		return legacySyncPath(ctx, client, logger, concurrent, authPath)
	}
	if berr != nil {
		// Treat network/server failure as "offline" for Decide().
		offline := &orchestrator.AuthRetrieveResponse{Status: "offline", Message: berr.Error()}
		return offline, berr, false, false, false
	}

	// Apply bundle outputs.
	authResp := resp.Auth
	if authResp == nil {
		authResp = &orchestrator.AuthRetrieveResponse{Status: "offline", Message: "bundle missing auth block"}
	}
	authSynced := false
	if !concurrent && len(authResp.Auth) > 0 {
		switch strings.ToLower(authResp.Status) {
		case "outdated", "updated", "missing":
			if err := codex.WriteAuth(authResp.Auth); err != nil {
				logger.Warn("auth write from bundle failed", "err", err)
			} else {
				authSynced = true
				logger.Info("auth.json updated from /sync/bootstrap")
			}
		}
	}

	agentsUpdated := false
	configUpdated := false
	if !concurrent {
		if len(resp.Agents) > 0 {
			if err := atomicWrite(agentsPath(), resp.Agents, 0o644); err != nil {
				logger.Debug("bundle agents write failed", "err", err)
			} else {
				agentsUpdated = true
			}
		}
		if len(resp.Config) > 0 {
			if err := atomicWrite(configTomlPath(), resp.Config, 0o644); err != nil {
				logger.Debug("bundle config write failed", "err", err)
			} else {
				configUpdated = true
			}
		}
	}
	return authResp, nil, authSynced, agentsUpdated, configUpdated
}

// legacySyncPath runs the per-resource sync (auth + agents + config) when the
// server is too old for /sync/bootstrap.
func legacySyncPath(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, concurrent bool, authPath string) (*orchestrator.AuthRetrieveResponse, error, bool, bool, bool) {
	authResp, authErr, authSynced := syncAuthLegacy(ctx, client, logger, concurrent)

	var agents, conf bool
	if !concurrent {
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
	}
	_ = authPath
	return authResp, authErr, authSynced, agents, conf
}

// isBundleUnsupported returns true when the error looks like a 404/501 from
// the bundle endpoint; everything else is treated as a transient failure
// (offline) so the wrapper doesn't fan out into legacy sync on every hiccup.
func isBundleUnsupported(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, " -> 404") || strings.Contains(s, " -> 501") || strings.Contains(s, " -> 405")
}

// pushAuthCandidate uploads the local file via the standalone /auth store
// endpoint. (The bundle endpoint also accepts auth_candidate inline, but on
// the upload-required path we want a direct round-trip so we get a stable
// store-side error if it rejects.)
func pushAuthCandidate(ctx context.Context, client *orchestrator.Client, raw []byte) error {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return client.AuthStore(cctx, raw)
}

func syncAuthLegacy(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, concurrent bool) (*orchestrator.AuthRetrieveResponse, error, bool) {
	digest, err := codex.LocalDigest()
	if err != nil {
		return nil, fmt.Errorf("local digest: %w", err), false
	}
	resp, err := client.AuthRetrieve(ctx, digest)
	if err != nil {
		return &orchestrator.AuthRetrieveResponse{Status: "offline", Message: err.Error()}, err, false
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
			return resp, nil, false
		}
		if err := codex.WriteAuth(resp.Auth); err != nil {
			return resp, err, false
		}
		logger.Info("auth.json updated from orchestrator")
		return resp, nil, true
	default:
		// Unknown / refused / insecure — return the response as-is and let
		// Decide() classify; do not synthesise an error here.
		return resp, nil, false
	}
}

func writeAgents(ctx context.Context, client *orchestrator.Client) (bool, error) {
	dst := agentsPath()
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
	dst := configTomlPath()
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

func agentsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "AGENTS.md")
}

func configTomlPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "config.toml")
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

// snapshotAuth returns (sha256, last_refresh) for the local auth.json. Either
// can be empty on a missing or unparseable file.
func snapshotAuth(path string) (string, string) {
	if path == "" {
		return "", ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", ""
	}
	sum := sha256.Sum256(raw)
	hash := hex.EncodeToString(sum[:])
	refresh := extractLastRefresh(raw)
	return hash, refresh
}

func extractLastRefresh(raw []byte) string {
	// Cheap, allocation-light scan — we don't need the rest of the doc.
	idx := strings.Index(string(raw), `"last_refresh"`)
	if idx < 0 {
		return ""
	}
	tail := string(raw)[idx+len(`"last_refresh"`):]
	// Skip whitespace and the colon.
	for i := 0; i < len(tail); i++ {
		if tail[i] == ':' {
			tail = tail[i+1:]
			break
		}
	}
	tail = strings.TrimLeft(tail, " \t")
	if !strings.HasPrefix(tail, `"`) {
		return ""
	}
	tail = tail[1:]
	end := strings.IndexByte(tail, '"')
	if end < 0 {
		return ""
	}
	return tail[:end]
}

// maybePostRunAuthUpload pushes the local file back when either the SHA or
// last_refresh changed during the run (codex login mid-session, token rotation).
// Best-effort: any failure is logged at debug and never aborts the run.
func maybePostRunAuthUpload(client *orchestrator.Client, logger *slog.Logger, path, beforeHash, beforeRefresh string) {
	if path == "" {
		return
	}
	afterHash, afterRefresh := snapshotAuth(path)
	if afterHash == "" {
		return
	}
	if afterHash == beforeHash && afterRefresh == beforeRefresh {
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		logger.Debug("post-run auth read failed", "err", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.AuthStore(ctx, raw); err != nil {
		logger.Debug("post-run auth upload failed", "err", err)
		return
	}
	logger.Debug("post-run auth uploaded", "hash_changed", beforeHash != afterHash, "refresh_changed", beforeRefresh != afterRefresh)
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

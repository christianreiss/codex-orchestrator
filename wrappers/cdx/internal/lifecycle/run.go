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
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ui"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/update"
)

type Options struct {
	Config         *config.Config
	ExtraArgs      []string
	SkipAuthSync   bool
	SkipBoot       bool
	Minimal        bool
	Logger         *slog.Logger
	WrapperVersion string
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
		codexUpdated  string
		fleetSessions *orchestrator.FleetSessions
		dec           orchestrator.AuthDecision
	)

	if !opts.SkipAuthSync {
		authResp, authErr, authSynced, agentsUpdated, configUpdated, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
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
				authResp, authErr, authSynced, agentsUpdated, configUpdated, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
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
					authResp, authErr, authSynced, agentsUpdated, configUpdated, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
					dec = orchestrator.Decide(authResp, authPath, cfg.Host.Secure, localProbe)
				}
			}
		}

		// PR-2: keep the local Codex CLI within range of the server-declared
		// target version when auto-update is enabled. Never blocks launch.
		if dec.Allowed {
			maybeEnsureWrapper(ctx, cfg, authResp, currentWrapperVersion(opts, cfg), concurrent, logger)
			codexUpdated = maybeEnsureCodex(ctx, authResp, concurrent, logger)
		}

		// Skills are MCP-served in v2; we still ping /skills to detect
		// fingerprint changes (lights the boot-screen "skills" dot) and
		// purge bash-era on-disk caches once per wrapper version so they
		// don't shadow MCP resolution. Both are best-effort.
		if !concurrent {
			skillsUpdated = syncSkills(ctx, client, logger)
			pruneLegacySkillDirs(wrapperVersion(cfg), logger)
		}
	}

	// Build the boot-screen state once: even when SkipBoot suppresses the
	// rendered screen we still want the derived QuotaWarn text so headless
	// callers (cron, --execute) see the warning on stderr.
	state := summary.Build(ctx, summary.Inputs{
		Config:         cfg,
		WrapperVersion: currentWrapperVersion(opts, cfg),
		Auth:           authResp,
		AuthErr:        authErr,
		Concurrent:     concurrent,
		ConcurrentNote: concurrentNote(concurrent, dec),
		SkillsUpdated:  skillsUpdated,
		AgentsUpdated:  agentsUpdated,
		ConfigUpdated:  configUpdated,
		AuthSynced:     authSynced,
		CodexUpdated:   codexUpdated,
		Sessions:       buildSessionCounts(fleetSessions),
	})
	if !dec.Allowed && dec.Reason != "" {
		state.ResultLabel = dec.Reason
		state.ResultTone = ui.ToneFail
	}
	if !opts.SkipBoot {
		if opts.Minimal {
			ui.PrintMinimalScreen(os.Stderr, state)
		} else {
			ui.PrintBootScreen(os.Stderr, state)
		}
	} else if state.QuotaWarn != "" {
		// Headless path: surface the quota warning so cron/CI logs capture
		// it. The boot-screen path already renders this text inline.
		fmt.Fprintln(os.Stderr, "cdx: "+state.QuotaWarn)
		logger.Warn("quota approaching limit", "warn", state.QuotaWarn)
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
	exitCode, captured, runErr := codex.RunCapture(ctx, cfg, opts.ExtraArgs)
	duration := time.Since(started)

	// Post-exec auth upload (best-effort, 5s budget). A `codex login` mid-run
	// rotates tokens; we want to push the rotated payload to canonical store.
	maybePostRunAuthUpload(client, logger, authPath, beforeHash, beforeRefresh)

	usageResult, usageTone := reportUsage(client, cfg, started, duration, captured, exitCode, logger)

	// Exit footer.
	if !opts.SkipBoot {
		caps := ui.DetectCaps(themeFromConfig(cfg))
		fmt.Fprintln(os.Stderr)
		ui.PrintExitFooter(os.Stderr, caps, "cdx", ui.ExitFooter{
			When:         time.Now(),
			HeaderText:   "Run summary",
			RunDuration:  duration,
			UsageStatus:  usageResult,
			UsageTone:    usageTone,
			AuthStatus:   "not-needed",
			AuthTone:     ui.ToneOK,
			CodexVersion: codexUpdated,
		})
	}

	return exitCode, runErr
}

// bootstrap tries SyncBootstrap first and, on 404/501, falls back to the
// per-resource pulls. Returns the same tuple regardless of which path ran.
// The last value carries the fleet-session counts when the bundle path was
// taken (nil on the legacy path or when the server didn't supply them).
func bootstrap(
	ctx context.Context, client *orchestrator.Client, logger *slog.Logger,
	concurrent bool, authPath string,
) (*orchestrator.AuthRetrieveResponse, error, bool, bool, bool, *orchestrator.FleetSessions) {
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
		a, e, s, ag, co := legacySyncPath(ctx, client, logger, concurrent, authPath)
		return a, e, s, ag, co, nil
	}
	if berr != nil {
		// Insecure-approval gate (423 pending / 403 denied) is not an outage:
		// map it to the auth status so the launch gate polls for approval
		// instead of falling through to the offline branch.
		if st := orchestrator.InsecureStatusFromError(berr); st != "" {
			return &orchestrator.AuthRetrieveResponse{Status: st}, nil, false, false, false, nil
		}
		// Treat network/server failure as "offline" for Decide().
		offline := &orchestrator.AuthRetrieveResponse{Status: "offline", Message: berr.Error()}
		return offline, berr, false, false, false, nil
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
				logger.Debug("auth.json updated from /sync/bootstrap")
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
	return authResp, nil, authSynced, agentsUpdated, configUpdated, resp.Sessions
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
		logger.Debug("auth.json updated from orchestrator")
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

// reportUsage extracts token counts (pipe-mode capture first, JSONL session
// files as fallback) and POSTs the legacy `{engine,fqdn,usages:[…]}` batch
// to /usage. Best-effort: any failure is logged at debug and surfaced in the
// exit footer, never blocking the foreground exec.
func reportUsage(client *orchestrator.Client, cfg *config.Config, started time.Time, dur time.Duration, captured []byte, exit int, logger *slog.Logger) (string, ui.Tone) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	model := ""
	if cfg.EngineOptions.ModelOverride != nil {
		model = *cfg.EngineOptions.ModelOverride
	}

	var tokens codex.Tokens
	var line string
	if len(captured) > 0 {
		if t, ok := codex.ParseStdoutCapture(captured); ok {
			tokens = t
			line = extractUsageLine(captured)
		}
	}
	if tokens.IsZero() {
		if home, herr := os.UserHomeDir(); herr == nil {
			files, _ := codex.DiscoverSessions(filepath.Join(home, ".codex", "sessions"), started)
			for _, f := range files {
				if t, err := codex.ParseSessionJSONL(f); err == nil {
					tokens.Add(t)
				}
			}
		}
	}

	entry := orchestrator.UsageEntry{
		Model:     model,
		Total:     tokens.Total,
		Input:     tokens.Input,
		Output:    tokens.Output,
		Cached:    tokens.Cached,
		Reasoning: tokens.Reasoning,
		Duration:  dur.Seconds(),
		Line:      line,
	}
	batch := orchestrator.UsagesBatch{
		Engine: "codex",
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

// extractUsageLine pulls the literal "Token usage: …" line from the captured
// stdout buffer so the server-side audit log shows the upstream phrasing.
// Strips ANSI/control bytes to match the legacy bash payload.
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

// lineStripper is a cheap one-shot noise filter for log lines (ANSI CSI +
// the common control chars). codex/usage.go has the full triple-pass; here
// we just need clean enough output for the audit string.
var lineStripper = regexp.MustCompile(`\x1B\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`)

// concurrentNote picks the right "Concurrent" row text for the boot screen.
// Empty string means PrintConcurrentRow uses its own default
// ("Using local auth.json."); we override only when local auth is unusable so
// the operator sees why a second run would block.
func concurrentNote(concurrent bool, dec orchestrator.AuthDecision) string {
	if !concurrent {
		return ""
	}
	if dec.LocalUsable {
		return "Using local auth.json."
	}
	if !dec.Allowed {
		return "Local auth.json is missing or invalid."
	}
	return ""
}

// wrapperVersion returns a short identifier used to gate the one-shot legacy
// skill-dir cleanup. Falls back to "dev" so the sentinel still works in
// unconfigured local builds.
func wrapperVersion(cfg *config.Config) string {
	if cfg != nil && cfg.Wrapper.Version != "" {
		return cfg.Wrapper.Version
	}
	return "dev"
}

func currentWrapperVersion(opts Options, cfg *config.Config) string {
	if opts.WrapperVersion != "" {
		return opts.WrapperVersion
	}
	return wrapperVersion(cfg)
}

func themeFromConfig(cfg *config.Config) string {
	if cfg == nil || cfg.EngineOptions.AdminThemeHint == nil {
		return ""
	}
	return *cfg.EngineOptions.AdminThemeHint
}

// maybeEnsureCodex repairs the local Codex CLI when the orchestrator says
// auto-update is enabled, a target version is known, and the local CLI
// version differs from that target. Failures are logged but never blocking
// — the launch path continues regardless so a transient install error does
// not prevent the user from running Codex.
//
// Returns the post-install version when an install actually ran successfully,
// empty string otherwise (no-op cases + failures). The caller plumbs this
// into summary.Inputs so the exit footer's Sync row can show a `● codex X.Y.Z`
// badge.
//
// This is a no-op in concurrent (read-only) mode, when auth retrieval
// failed, or when AutoUpdateEnabled is false.
func maybeEnsureCodex(ctx context.Context, auth *orchestrator.AuthRetrieveResponse, concurrent bool, logger *slog.Logger) string {
	if concurrent || auth == nil || auth.Versions == nil {
		return ""
	}
	v := auth.Versions
	if !v.AutoUpdateEnabled {
		return ""
	}
	if v.ClientVersion == nil || *v.ClientVersion == "" {
		return ""
	}
	target := *v.ClientVersion
	if v.ClientVersionOverride != nil && *v.ClientVersionOverride != "" {
		target = *v.ClientVersionOverride
	}
	current := strings.TrimSpace(codex.Version(ctx))
	if current == target {
		return ""
	}
	if target == "" {
		return ""
	}
	if target == "latest" {
		latest, err := codex.LatestVersion(ctx)
		if err != nil {
			logger.Warn("codex latest-version probe failed", "err", err, "current", current)
		} else if current == latest {
			return ""
		}
	}
	// EnsureCodex is a 5-10s blocking operation when an install actually
	// downloads from GitHub. Surface a single human-readable progress line
	// on stderr so the user knows what's happening — the structured-log
	// emissions inside the installer are at Debug now.
	if current == "" || current == "unknown" {
		fmt.Fprintf(os.Stderr, "cdx: installing codex CLI %s…\n", target)
	} else {
		fmt.Fprintf(os.Stderr, "cdx: installing codex CLI %s → %s…\n", current, target)
	}
	if err := codex.EnsureCodex(ctx, target, v.ClientVersionEnforceExact, logger); err != nil {
		logger.Warn("codex auto-update skipped", "err", err, "target", target, "current", current)
		return ""
	}
	post := strings.TrimSpace(codex.Version(ctx))
	if post == "" || post == "unknown" {
		post = target
	}
	fmt.Fprintf(os.Stderr, "cdx: codex CLI updated to %s\n", post)
	return post
}

func maybeEnsureWrapper(ctx context.Context, cfg *config.Config, auth *orchestrator.AuthRetrieveResponse, current string, concurrent bool, logger *slog.Logger) {
	if concurrent || cfg == nil || auth == nil || auth.Versions == nil {
		return
	}
	v := auth.Versions
	if !v.AutoUpdateEnabled || v.WrapperVersion == nil || *v.WrapperVersion == "" {
		return
	}
	target := *v.WrapperVersion
	if current == target {
		return
	}
	if os.Getenv("CODEX_WRAPPER_RESTARTED") == "1" {
		logger.Warn("wrapper auto-update skipped after restart", "current", current, "target", target)
		return
	}
	if v.WrapperURL == nil || *v.WrapperURL == "" || v.WrapperSHA256 == nil || *v.WrapperSHA256 == "" {
		logger.Warn("wrapper auto-update skipped: missing artifact metadata", "current", current, "target", target)
		return
	}
	if current == "" || current == "unknown" {
		fmt.Fprintf(os.Stderr, "cdx: installing wrapper %s...\n", target)
	} else {
		fmt.Fprintf(os.Stderr, "cdx: installing wrapper %s -> %s...\n", current, target)
	}
	exe, err := update.SelfUpdateFrom(ctx, cfg, *v.WrapperURL, *v.WrapperSHA256, target, logger)
	if err != nil {
		logger.Warn("wrapper auto-update skipped", "err", err, "target", target, "current", current)
		fmt.Fprintf(os.Stderr, "cdx: wrapper auto-update skipped: %v\n", err)
		return
	}
	fmt.Fprintf(os.Stderr, "cdx: wrapper updated to %s; restarting...\n", target)
	if err := update.ReExecAfterUpdate(exe, update.SnapshottedArgv); err != nil {
		logger.Warn("wrapper restart after update failed", "err", err)
		fmt.Fprintf(os.Stderr, "cdx: wrapper restart after update failed: %v\n", err)
	}
}

// buildSessionCounts merges the wrapper-side local count (this host's
// concurrent cdx processes, walked from /proc) with the fleet aggregates the
// server returned in the /sync/bootstrap response. When the server omitted
// the fleet block entirely (legacy server, offline, etc.), the whole
// SessionCounts is nil so the boot screen skips the block — there's no
// useful "local-only" rendering without the fleet context.
func buildSessionCounts(fs *orchestrator.FleetSessions) *summary.SessionCounts {
	if fs == nil {
		return nil
	}
	return &summary.SessionCounts{
		LocalNow: int64(ipc.CountActive("cdx")),
		FleetNow: fs.Now,
		Today:    fs.Today,
		Month:    fs.Month,
	}
}

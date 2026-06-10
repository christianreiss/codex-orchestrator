// Package lifecycle orchestrates the startup sequence for a single `clx run`:
// lock → bundle (auth + agents + settings in one POST) → decide → boot screen
// → pre-exec → Claude → post-exec auth upload → usage report → exit footer.
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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/peer"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/update"
)

type Options struct {
	Config         *config.Config
	ExtraArgs      []string
	SkipAuthSync   bool
	SkipBoot       bool
	Minimal        bool
	WrapperVersion string
	Logger         *slog.Logger
}

// localProbe binds the claude package freshness/validity helpers to the
// engine-neutral LocalAuthProbe consumed by orchestrator.Decide.
var localProbe = orchestrator.LocalAuthProbe{
	IsValid: claude.IsValidLocalAuth,
	IsFresh: claude.IsFresh,
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

	authPath, _ := claude.AuthPath()

	var (
		authResp      *orchestrator.AuthRetrieveResponse
		authErr       error
		authSynced    bool
		agentsUpdated bool
		configUpdated bool
		skillsUpdated bool
		claudeUpdated string
		dec           orchestrator.AuthDecision
	)

	if !opts.SkipAuthSync {
		authResp, authErr, authSynced, agentsUpdated, configUpdated = bootstrap(ctx, client, logger, concurrent, authPath)
		dec = orchestrator.Decide(authResp, authPath, cfg.Host.Secure, localProbe)

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

		if !concurrent && dec.Allowed && (dec.Status == "missing" || dec.Status == "upload_required") {
			if raw, _, rerr := claude.ReadAuthForUpload(); rerr == nil && len(raw) > 0 {
				if err := pushAuthCandidate(ctx, client, raw, logger); err != nil {
					logger.Warn("auth-candidate upload failed", "err", err)
				} else {
					authResp, authErr, authSynced, agentsUpdated, configUpdated = bootstrap(ctx, client, logger, concurrent, authPath)
					dec = orchestrator.Decide(authResp, authPath, cfg.Host.Secure, localProbe)
				}
			}
		}

		// PR-2: keep the local Claude CLI within range of the server-declared
		// target version when auto-update is enabled. Never blocks launch.
		if dec.Allowed {
			maybeEnsureWrapper(ctx, cfg, authResp, currentWrapperVersion(opts, cfg), concurrent, logger)
			claudeUpdated = maybeEnsureClaude(ctx, authResp, concurrent, logger)
			if !concurrent {
				peer.Reconcile(ctx, cfg, authResp, logger)
				// Fresh hosts: minted credentials alone don't stop Claude's
				// first-start login wizard — ~/.claude.json must carry the
				// onboarding flag too.
				if claude.HasUsableAuth() {
					ensureOnboardingState(logger)
				}
			}
		}

		// Skills are MCP-served in v2; we still ping /skills?engine=claude
		// to detect fingerprint changes (lights the boot-screen "skills"
		// dot) and purge bash-era on-disk caches once per wrapper version
		// so they don't shadow MCP resolution. Both best-effort.
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
		ClaudeUpdated:  claudeUpdated,
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
	}
	// Claude has no quota bars in this orchestrator (see clx/internal/ui/screen.go);
	// there is therefore no headless QuotaWarn emission to make here.

	if !opts.SkipAuthSync && !dec.Allowed {
		// On an explicit server refusal (not a transient outage), surgically
		// remove fleet-managed settings keys + collection files so a host that
		// lost trust no longer carries fleet hooks/permissions/subagents. We
		// never strip on "offline" — that would wipe a fleet during an outage.
		if !concurrent {
			switch dec.Status {
			case "disabled", "invalid", "insecure-denied":
				stripManagedSettings(logger)
				stripClaudeCollections(logger)
				stripClaudeSkills(logger)
			}
		}
		return 1, fmt.Errorf("launch refused: %s", dec.Reason)
	}

	before := snapshotAuthFiles()

	started := time.Now()
	exitCode, captured, runErr := claude.RunCapture(ctx, cfg, opts.ExtraArgs)
	duration := time.Since(started)

	maybePostRunAuthUpload(client, logger, before)

	usageResult, usageTone := reportUsage(client, cfg, started, duration, captured, exitCode, logger)

	if !opts.SkipBoot {
		caps := ui.DetectCaps(themeFromConfig(cfg))
		fmt.Fprintln(os.Stderr)
		ui.PrintExitFooter(os.Stderr, caps, "clx", ui.ExitFooter{
			When:         time.Now(),
			HeaderText:   "Run summary",
			RunDuration:  duration,
			UsageStatus:  usageResult,
			UsageTone:    usageTone,
			AuthStatus:   "not-needed",
			AuthTone:     ui.ToneOK,
			CodexVersion: claudeUpdated,
		})
	}

	return exitCode, runErr
}

func bootstrap(
	ctx context.Context, client *orchestrator.Client, logger *slog.Logger,
	concurrent bool, authPath string,
) (*orchestrator.AuthRetrieveResponse, error, bool, bool, bool) {
	digest, _ := claude.LocalDigest()
	agentsDigest := fileDigest(agentsPath())
	configDigest := fileDigest(settingsPath())

	var candidate []byte
	if raw, err := claude.ReadAuth(); err == nil {
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

	// Advertise on-disk digests for the flat collections AND the skills (skills
	// ride the same `artifacts` map under the "skill" key) so the server can omit
	// unchanged content.
	reqArtifacts := artifactDigestsForRequest()
	if skillDigests := skillDigestsForRequest(); len(skillDigests) > 0 {
		if reqArtifacts == nil {
			reqArtifacts = map[string]map[string]string{}
		}
		reqArtifacts["skill"] = skillDigests
	}

	resp, berr := client.SyncBootstrap(bctx, orchestrator.BundleRequest{
		Engine:        "claude",
		IncludeAuth:   true,
		AuthDigest:    digest,
		AuthCandidate: candidate,
		Agents:        agentsDigest,
		Config:        configDigest,
		Home:          home,
		Username:      username,
		Artifacts:     reqArtifacts,
	})

	if berr != nil && isBundleUnsupported(berr) {
		logger.Debug("bundle endpoint unsupported, falling back", "err", berr)
		return legacySyncPath(ctx, client, logger, concurrent, authPath)
	}
	if berr != nil {
		// Insecure-approval gate (423 pending / 403 denied) is not an outage:
		// map it to the auth status so the launch gate polls for approval
		// instead of falling through to the offline branch.
		if st := orchestrator.InsecureStatusFromError(berr); st != "" {
			return &orchestrator.AuthRetrieveResponse{Status: st}, nil, false, false, false
		}
		offline := &orchestrator.AuthRetrieveResponse{Status: "offline", Message: berr.Error()}
		return offline, berr, false, false, false
	}

	authResp := resp.Auth
	if authResp == nil {
		authResp = &orchestrator.AuthRetrieveResponse{Status: "offline", Message: "bundle missing auth block"}
	}
	authSynced := false
	if !concurrent && len(authResp.Auth) > 0 {
		switch strings.ToLower(authResp.Status) {
		case "outdated", "updated", "missing":
			if err := claude.WriteAuth(authResp.Auth); err != nil {
				logger.Warn("credentials.json write from bundle failed", "err", err)
			} else {
				authSynced = true
				logger.Debug("credentials.json updated from /sync/bootstrap")
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
		// Settings: prefer the deep-merge partial (preserves user-owned keys);
		// fall back to the legacy wholesale write only for old servers that
		// don't return claude_settings.
		if resp.ClaudeSettings != nil && len(resp.ClaudeSettings.Partial) > 0 {
			if applyManagedSettings(resp.ClaudeSettings, logger) {
				configUpdated = true
			}
		} else if len(resp.Config) > 0 {
			if err := atomicWrite(settingsPath(), resp.Config, 0o644); err != nil {
				logger.Debug("bundle settings write failed", "err", err)
			} else {
				configUpdated = true
			}
		}
		// Claude-native collections (subagents / commands / output-styles).
		// Folded into configUpdated for the boot-screen "config" dot; writes are
		// manifest-tracked and never touch user-authored files in those dirs.
		if applyClaudeArtifacts(resp.ClaudeArtifacts, logger) {
			configUpdated = true
		}
		// On-disk skills → ~/.claude/skills/<slug>/SKILL.md (Claude Code's native
		// skill layout; it can't read skills over MCP like codex does).
		if applyClaudeSkills(resp.ClaudeSkills, logger) {
			configUpdated = true
		}
	}
	return authResp, nil, authSynced, agentsUpdated, configUpdated
}

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
			u, err := writeSettings(syncCtx, client)
			if err != nil {
				logger.Debug("settings sync skipped", "err", err)
			}
			conf = u
		}()
		wg.Wait()
	}
	_ = authPath
	return authResp, authErr, authSynced, agents, conf
}

func isBundleUnsupported(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, " -> 404") || strings.Contains(s, " -> 501") || strings.Contains(s, " -> 405")
}

func pushAuthCandidate(ctx context.Context, client *orchestrator.Client, raw []byte, logger *slog.Logger) error {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := client.AuthStore(cctx, raw)
	if err != nil {
		return err
	}
	if resp != nil && len(resp.Auth) > 0 {
		if werr := claude.WriteAuth(resp.Auth); werr != nil {
			logger.Debug("auth write-back after upload failed", "err", werr)
		}
	}
	return nil
}

func syncAuthLegacy(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, concurrent bool) (*orchestrator.AuthRetrieveResponse, error, bool) {
	digest, err := claude.LocalDigest()
	if err != nil {
		return nil, err, false
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
			return resp, nil, false
		}
		if len(resp.Auth) == 0 {
			return resp, nil, false
		}
		if err := claude.WriteAuth(resp.Auth); err != nil {
			return resp, err, false
		}
		logger.Debug("credentials.json updated from orchestrator")
		return resp, nil, true
	default:
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

func writeSettings(ctx context.Context, client *orchestrator.Client) (bool, error) {
	dst := settingsPath()
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
	// Legacy clx parity: mirror the same bytes to ~/.clx/config/settings.json
	// so the clx-native config tree stays in sync. Best-effort — mirror
	// failures are not surfaced to the caller.
	if home, err := os.UserHomeDir(); err == nil {
		_ = atomicWrite(filepath.Join(home, ".clx", "config", "settings.json"), body, 0o644)
	}
	return true, nil
}

func agentsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "CLAUDE.md")
}

func settingsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "settings.json")
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

type authSnapshot struct {
	Hash    string
	Refresh string
}

func snapshotAuthFiles() map[string]authSnapshot {
	out := map[string]authSnapshot{}
	paths, err := claude.AuthCandidatePaths()
	if err != nil {
		return out
	}
	for _, path := range paths {
		hash, refresh := snapshotAuth(path)
		if hash != "" {
			out[path] = authSnapshot{Hash: hash, Refresh: refresh}
		}
	}
	return out
}

func snapshotAuth(path string) (string, string) {
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
	idx := strings.Index(string(raw), `"last_refresh"`)
	if idx < 0 {
		return ""
	}
	tail := string(raw)[idx+len(`"last_refresh"`):]
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

func maybePostRunAuthUpload(client *orchestrator.Client, logger *slog.Logger, before map[string]authSnapshot) {
	raw, path, err := claude.ReadAuthForUpload()
	if err != nil || len(raw) == 0 || path == "" {
		return
	}
	afterHash, afterRefresh := snapshotAuth(path)
	if afterHash == "" {
		return
	}
	if prev, ok := before[path]; ok && prev.Hash == afterHash && prev.Refresh == afterRefresh {
		return
	}
	// 15s budget: a login during the session is the one credential mint the
	// fleet must not lose — give the upload room and make failure visible.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, err := client.AuthStore(ctx, raw)
	if err != nil {
		logger.Warn("post-run auth upload failed", "err", err)
		return
	}
	if resp != nil && len(resp.Auth) > 0 {
		if werr := claude.WriteAuth(resp.Auth); werr != nil {
			logger.Warn("post-run auth write-back failed", "err", werr)
		}
	}
	prev := before[path]
	logger.Debug("post-run auth uploaded", "path", path, "hash_changed", prev.Hash != afterHash, "refresh_changed", prev.Refresh != afterRefresh)
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

// concurrentNote picks the right "Concurrent" row text for the boot screen.
// Empty string means PrintConcurrentRow uses its own default
// ("Using local credentials."); we override only when local auth is unusable
// so the operator sees why a second run would block.
func concurrentNote(concurrent bool, dec orchestrator.AuthDecision) string {
	if !concurrent {
		return ""
	}
	if dec.LocalUsable {
		return "Using local credentials."
	}
	if !dec.Allowed {
		return "Local credentials missing or invalid."
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

// maybeEnsureClaude repairs the local Claude CLI when the orchestrator
// reports auto-update enabled and the local version differs from target.
// Failures are logged but never block launch.
//
// Returns the post-install claude version when an install actually ran,
// empty otherwise. See the cdx-side counterpart for the rationale.
func maybeEnsureClaude(ctx context.Context, auth *orchestrator.AuthRetrieveResponse, concurrent bool, logger *slog.Logger) string {
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
	current := strings.TrimSpace(claude.Version(ctx))
	// Defer "latest" alias upgrades to cron — must be before the semver guards.
	if target == "" || target == "latest" {
		return ""
	}
	if claude.IsDowngrade(current, target) {
		logger.Debug("skipping downgrade", "current", current, "target", target)
		return ""
	}
	if current == "" || current == "unknown" {
		fmt.Fprintf(os.Stderr, "clx: installing claude CLI %s…\n", target)
	} else {
		fmt.Fprintf(os.Stderr, "clx: installing claude CLI %s → %s…\n", current, target)
	}
	if err := claude.EnsureClaude(ctx, target, v.ClientVersionEnforceExact, logger); err != nil {
		logger.Warn("claude auto-update skipped", "err", err, "target", target, "current", current)
		return ""
	}
	post := strings.TrimSpace(claude.Version(ctx))
	if post == "" || post == "unknown" {
		post = target
	}
	fmt.Fprintf(os.Stderr, "clx: claude CLI updated to %s\n", post)
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
	if current != "" && current != "unknown" && !semverGT(target, current) {
		logger.Warn("skipping wrapper downgrade", "current", current, "target", target)
		return
	}
	if os.Getenv("CLAUDE_WRAPPER_RESTARTED") == "1" {
		logger.Warn("wrapper auto-update skipped after restart", "current", current, "target", target)
		return
	}
	if v.WrapperURL == nil || *v.WrapperURL == "" || v.WrapperSHA256 == nil || *v.WrapperSHA256 == "" {
		logger.Warn("wrapper auto-update skipped: missing artifact metadata", "current", current, "target", target)
		return
	}
	if current == "" || current == "unknown" {
		fmt.Fprintf(os.Stderr, "clx: installing wrapper %s...\n", target)
	} else {
		fmt.Fprintf(os.Stderr, "clx: installing wrapper %s -> %s...\n", current, target)
	}
	exe, err := update.SelfUpdateFrom(ctx, cfg, *v.WrapperURL, *v.WrapperSHA256, target, logger)
	if err != nil {
		logger.Warn("wrapper auto-update skipped", "err", err, "target", target, "current", current)
		fmt.Fprintf(os.Stderr, "clx: wrapper auto-update skipped: %v\n", err)
		return
	}
	fmt.Fprintf(os.Stderr, "clx: wrapper updated to %s; restarting...\n", target)
	if err := update.ReExecAfterUpdate(exe, update.SnapshottedArgv); err != nil {
		logger.Warn("wrapper restart after update failed", "err", err)
		fmt.Fprintf(os.Stderr, "clx: wrapper restart after update failed: %v\n", err)
	}
}

// semverGT returns true when a > b using simple X.Y.Z numeric comparison.
// Returns false (not greater) when either string cannot be parsed.
func semverGT(a, b string) bool {
	parse := func(s string) (maj, min, pat int, ok bool) {
		p := strings.SplitN(strings.SplitN(s, "+", 2)[0], ".", 3)
		if len(p) != 3 {
			return
		}
		var err error
		if maj, err = strconv.Atoi(p[0]); err != nil {
			return
		}
		if min, err = strconv.Atoi(p[1]); err != nil {
			return
		}
		pre := strings.SplitN(p[2], "-", 2)[0]
		if pat, err = strconv.Atoi(pre); err != nil {
			return
		}
		ok = true
		return
	}
	aMaj, aMin, aPat, aOk := parse(a)
	bMaj, bMin, bPat, bOk := parse(b)
	if !aOk || !bOk {
		return false
	}
	if aMaj != bMaj {
		return aMaj > bMaj
	}
	if aMin != bMin {
		return aMin > bMin
	}
	return aPat > bPat
}

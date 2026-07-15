// Package lifecycle orchestrates the startup sequence for a single `clx run`:
// FQDN guard → lock → bundle (auth + agents + settings in one POST) → decide
// → boot screen → pre-exec → Claude → post-exec auth upload → exit footer.
package lifecycle

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"

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
	Config              *config.Config
	ExtraArgs           []string
	SkipAuthSync        bool
	SkipBoot            bool
	Minimal             bool
	Headless            bool
	AllowConcurrentSync bool
	WrapperVersion      string
	Logger              *slog.Logger
	// DangerouslySkipPermissions mirrors --dangerously-skip-permissions for
	// this run only: it lights the boot-screen warning badge. The flag itself
	// already rides ExtraArgs straight through to the upstream `claude`
	// binary; this field exists purely for the UX warning.
	DangerouslySkipPermissions bool
}

// localProbe binds the claude package freshness/validity helpers to the
// engine-neutral LocalAuthProbe consumed by orchestrator.Decide.
var localProbe = orchestrator.LocalAuthProbe{
	IsValid: claude.IsValidLocalAuth,
	IsFresh: claude.IsFresh,
}

var errAuthRecoveryDeclined = errors.New("Claude authentication was not refreshed")
var errAuthRecoveryNonInteractive = errors.New("Claude authentication refresh requires an interactive terminal")

type presentedError struct{ err error }

func (e *presentedError) Error() string { return e.err.Error() }
func (e *presentedError) Unwrap() error { return e.err }

func ErrorWasPresented(err error) bool {
	var target *presentedError
	return errors.As(err, &target)
}

func markPresented(err error, opts Options) error {
	if err != nil && !opts.SkipBoot {
		return &presentedError{err: err}
	}
	return err
}

func Run(ctx context.Context, opts Options) (int, error) {
	cfg := opts.Config
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	// Refuse a cloned or mis-deployed host before acquiring a run lock or
	// making any orchestrator request. PreExec repeats this immediately before
	// spawning Claude as defense-in-depth.
	if err := claude.GuardFQDN(cfg); err != nil {
		return 1, err
	}

	concurrent := false
	lock, err := ipc.Acquire("clx")
	if err != nil {
		if !errors.Is(err, ipc.ErrHeld) {
			return 1, err
		}
		if opts.AllowConcurrentSync {
			fmt.Fprintln(os.Stderr, "clx: another session is active; concurrent sync explicitly enabled")
		} else {
			concurrent = true
			fmt.Fprintln(os.Stderr, "clx: another session is active; managed content sync paused; auth freshness remains active")
		}
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
		authResp         *orchestrator.AuthRetrieveResponse
		authErr          error
		authSynced       bool
		agentsSync       summary.ResourceSync
		configSync       summary.ResourceSync
		nativeSkillsSync summary.ResourceSync
		skillsSync       summary.ResourceSync
		fleetSessions    *orchestrator.FleetSessions
		dec              orchestrator.AuthDecision
	)

	if !opts.SkipAuthSync {
		authResp, authErr, authSynced, agentsSync, configSync, nativeSkillsSync, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
		dec = orchestrator.Decide(authResp, authPath, cfg.Host.Secure, localProbe)

		if dec.NeedsApprovalPoll {
			if opts.Headless {
				dec.Allowed = false
				dec.Reason = "Insecure host approval is required; open Admin → Host Detail, then retry."
			} else {
				logger.Warn("auth status insecure; opening approval-pending box")
				resolved, perr := ui.PollApproval(ctx, client, 5*time.Second, opts.Minimal)
				if perr != nil && !errors.Is(perr, context.Canceled) {
					logger.Warn("approval poll failed", "err", perr)
				}
				if resolved {
					authResp, authErr, authSynced, agentsSync, configSync, nativeSkillsSync, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
					dec = orchestrator.Decide(authResp, authPath, cfg.Host.Secure, localProbe)
				}
			}
		}

		var authCandidateErr error
		if !concurrent && dec.Allowed && (dec.Status == "missing" || dec.Status == "upload_required") {
			if raw, _, rerr := claude.ReadAuthForUpload(); rerr == nil && len(raw) > 0 {
				if err := pushAuthCandidate(ctx, client, raw, logger); err != nil {
					authCandidateErr = err
					logger.Warn("auth-candidate upload failed", "err", err)
				} else {
					authResp, authErr, authSynced, agentsSync, configSync, nativeSkillsSync, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
					dec = orchestrator.Decide(authResp, authPath, cfg.Host.Secure, localProbe)
				}
			} else if rerr != nil {
				authCandidateErr = rerr
			}
		}

		if needsInteractiveAuthRecovery(dec, authCandidateErr) && !concurrent {
			reason := safeLifecycleText(recoveryReason(dec, authCandidateErr), opts.Minimal)
			if opts.Headless {
				dec.Allowed = false
				dec.Reason = reason
			} else if err := recoverClaudeAuth(ctx, cfg, client, logger, reason); err != nil {
				logger.Warn("interactive Claude auth recovery failed", "err", err)
				dec.Allowed = false
				dec.Reason = err.Error()
			} else {
				authResp, authErr, authSynced, agentsSync, configSync, nativeSkillsSync, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
				dec = orchestrator.Decide(authResp, authPath, cfg.Host.Secure, localProbe)
			}
		}

		// PR-2: keep the local Claude CLI within range of the server-declared
		// target version when auto-update is enabled. Never blocks launch.
		if dec.Allowed {
			maybeEnsureWrapper(ctx, cfg, authResp, currentWrapperVersion(opts, cfg), concurrent, opts.Minimal, logger)
			maybeEnsureClaude(ctx, cfg, authResp, concurrent, opts.Minimal, logger)
			if !concurrent {
				peer.Reconcile(ctx, cfg, authResp, opts.Minimal, logger)
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
			skillsSync = syncSkills(ctx, client, logger)
			skillsSync = combineResourceSync(skillsSync, pruneLegacySkillDirs(wrapperVersion(cfg), logger))
			skillsSync = combineOptionalResourceSync(skillsSync, nativeSkillsSync)
		}
	}

	if concurrent {
		dec = orchestrator.ApplyConcurrent(dec, authPath, localProbe)
	}

	// Build the boot-screen state once: even when SkipBoot suppresses the
	// rendered screen we still want the derived QuotaWarn text so headless
	// callers (cron, --execute) see the warning on stderr.
	state := summary.Build(ctx, summary.Inputs{
		Config:            cfg,
		WrapperVersion:    currentWrapperVersion(opts, cfg),
		Auth:              authResp,
		AuthErr:           authErr,
		Concurrent:        concurrent,
		ConcurrentNote:    concurrentNote(concurrent, dec),
		SkillsSync:        skillsSync,
		ConfigSync:        combineResourceSync(agentsSync, configSync),
		AuthSynced:        authSynced,
		BypassPermissions: opts.DangerouslySkipPermissions,
		Sessions:          buildSessionCounts(fleetSessions),
	})
	if !dec.Allowed && dec.Reason != "" {
		state.ResultLabel = dec.Reason
		state.ResultTone = ui.ToneFail
	}
	if dec.Allowed && strings.EqualFold(dec.Status, "offline") {
		state.ResultLabel = dec.Reason
		if strings.TrimSpace(state.ResultLabel) == "" {
			state.ResultLabel = "API offline; using cached credentials."
		}
		state.ResultTone = ui.ToneWarn
		markOfflineHealth(state.Dots)
	} else if dec.Allowed && concurrent && state.ResultTone != ui.ToneFail {
		state.ResultLabel = "Managed content sync paused; auth freshness remains active."
		state.ResultTone = ui.ToneWarn
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
				cleanupErr := errors.Join(
					stripManagedSettings(logger),
					stripClaudeCollections(logger),
					stripClaudeSkills(logger),
				)
				if cleanupErr != nil {
					logger.Warn("managed trust-loss cleanup incomplete; ownership retained for retry", "err", cleanupErr)
					return 1, fmt.Errorf("managed cleanup incomplete after launch refusal: %w", cleanupErr)
				}
			}
		}
		return 1, markPresented(fmt.Errorf("launch refused: %s", dec.Reason), opts)
	}

	before := snapshotAuthFiles()

	started := time.Now()
	exitCode, _, runErr := claude.RunCapture(ctx, cfg, opts.ExtraArgs)
	duration := time.Since(started)

	authStatus, authTone := maybePostRunAuthUpload(client, logger, before)

	if !opts.SkipBoot {
		caps := footerCaps(ui.DetectCaps(themeFromConfig(cfg)), opts.Minimal)
		fmt.Fprintln(os.Stderr)
		footerExit := exitCode
		if runErr != nil && footerExit == 0 {
			footerExit = 1
		}
		ui.PrintExitFooter(os.Stderr, caps, "clx", ui.ExitFooter{
			RunDuration:   duration,
			ExitCode:      footerExit,
			AuthStatus:    authStatus,
			AuthTone:      authTone,
			EngineName:    "claude",
			EngineVersion: claude.Version(ctx),
		})
	}

	return exitCode, runErr
}

func safeLifecycleText(value string, portable bool) string {
	if portable {
		return ui.PlainInline(value)
	}
	return ui.CleanInline(value)
}

func footerCaps(caps ui.Caps, minimal bool) ui.Caps {
	if minimal {
		return ui.MinimalCaps(caps)
	}
	return caps
}

func bootstrap(
	ctx context.Context, client *orchestrator.Client, logger *slog.Logger,
	concurrent bool, authPath string,
) (*orchestrator.AuthRetrieveResponse, error, bool, summary.ResourceSync, summary.ResourceSync, summary.ResourceSync, *orchestrator.FleetSessions) {
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
		a, e, s, ag, co := legacySyncPath(ctx, client, logger, concurrent, authPath)
		return a, e, s, ag, co, summary.ResourceSync{}, nil
	}
	if berr != nil {
		// Insecure-approval gate (423 pending / 403 denied) is not an outage:
		// map it to the auth status so the launch gate polls for approval
		// instead of falling through to the offline branch.
		if st := orchestrator.InsecureStatusFromError(berr); st != "" {
			return &orchestrator.AuthRetrieveResponse{Status: st}, nil, false, summary.ResourceSync{}, summary.ResourceSync{}, summary.ResourceSync{}, nil
		}
		offline := &orchestrator.AuthRetrieveResponse{Status: "offline", Message: berr.Error()}
		return offline, berr, false, summary.ResourceSync{}, summary.ResourceSync{}, summary.ResourceSync{}, nil
	}

	authResp := resp.Auth
	if authResp == nil {
		authResp = &orchestrator.AuthRetrieveResponse{Status: "offline", Message: "bundle missing auth block"}
	}
	authSynced := false
	if shouldWriteServerAuth(authResp.Status, authResp.Auth) {
		if err := claude.WriteAuth(authResp.Auth); err != nil {
			logger.Warn("credentials.json write from bundle failed", "err", err)
		} else {
			authSynced = true
			logger.Debug("credentials.json updated from /sync/bootstrap", "concurrent", concurrent)
		}
	}

	agentsSync := summary.ResourceSync{}
	configSync := summary.ResourceSync{}
	nativeSkillsSync := summary.ResourceSync{}
	if !concurrent {
		agentsSync.Checked = true
		if len(resp.Agents) > 0 {
			if err := atomicWrite(agentsPath(), resp.Agents, 0o644); err != nil {
				logger.Debug("bundle agents write failed", "err", err)
				agentsSync.Err = err
			} else {
				agentsSync.Updated = true
			}
		}
		configSync.Checked = true
		// Settings: prefer the deep-merge partial (preserves user-owned keys);
		// fall back to the legacy wholesale write only for old servers that
		// don't return claude_settings.
		if resp.ClaudeSettings != nil && len(resp.ClaudeSettings.Partial) > 0 {
			updated, err := applyManagedSettingsResult(resp.ClaudeSettings, logger)
			configSync.Updated = configSync.Updated || updated
			configSync.Err = errors.Join(configSync.Err, err)
		} else if len(resp.Config) > 0 {
			if err := atomicWrite(settingsPath(), resp.Config, 0o644); err != nil {
				logger.Debug("bundle settings write failed", "err", err)
				configSync.Err = errors.Join(configSync.Err, err)
			} else {
				configSync.Updated = true
			}
		}
		// Claude-native collections (subagents / commands / output-styles).
		// Folded into configSync for the boot-screen "config" dot; writes are
		// manifest-tracked and never touch user-authored files in those dirs.
		updated, err := applyClaudeArtifactsResult(resp.ClaudeArtifacts, logger)
		configSync.Updated = configSync.Updated || updated
		configSync.Err = errors.Join(configSync.Err, err)
		// On-disk skills → ~/.claude/skills/<slug>/SKILL.md (Claude Code's native
		// skill layout; it can't read skills over MCP like codex does). Keep this
		// outcome on the skills marker rather than masking it as config health.
		nativeSkillsSync = applyBundleClaudeSkills(resp.ClaudeSkills, logger)
	}
	return authResp, nil, authSynced, agentsSync, configSync, nativeSkillsSync, resp.Sessions
}

func legacySyncPath(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, concurrent bool, authPath string) (*orchestrator.AuthRetrieveResponse, error, bool, summary.ResourceSync, summary.ResourceSync) {
	authResp, authErr, authSynced := syncAuthLegacy(ctx, client, logger, concurrent)

	var agents, conf summary.ResourceSync
	if !concurrent {
		agents.Checked = true
		conf.Checked = true
		syncCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			agents.Updated, agents.Err = writeAgents(syncCtx, client)
			if agents.Err != nil {
				logger.Debug("agents sync skipped", "err", agents.Err)
			}
		}()
		go func() {
			defer wg.Done()
			conf.Updated, conf.Err = writeSettings(syncCtx, client)
			if conf.Err != nil {
				logger.Debug("settings sync skipped", "err", conf.Err)
			}
		}()
		wg.Wait()
	}
	_ = authPath
	return authResp, authErr, authSynced, agents, conf
}

func combineResourceSync(states ...summary.ResourceSync) summary.ResourceSync {
	if len(states) == 0 {
		return summary.ResourceSync{}
	}
	combined := summary.ResourceSync{Checked: true}
	for _, state := range states {
		combined.Checked = combined.Checked && state.Checked
		combined.Updated = combined.Updated || state.Updated
		combined.Err = errors.Join(combined.Err, state.Err)
	}
	return combined
}

// combineOptionalResourceSync folds a resource outcome into an already-probed
// marker only when the server actually advertised that resource. This keeps an
// older server that omits claude_skills from turning a successful skills probe
// into an unchecked/skipped result.
func combineOptionalResourceSync(base, optional summary.ResourceSync) summary.ResourceSync {
	if !optional.Checked && !optional.Updated && optional.Err == nil {
		return base
	}
	return combineResourceSync(base, optional)
}

func applyBundleClaudeSkills(items []orchestrator.CollectionItem, logger *slog.Logger) summary.ResourceSync {
	if items == nil {
		return summary.ResourceSync{}
	}
	updated, err := applyClaudeSkillsResult(items, logger)
	return summary.ResourceSync{Checked: true, Updated: updated, Err: err}
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

func needsInteractiveAuthRecovery(dec orchestrator.AuthDecision, uploadErr error) bool {
	if strings.EqualFold(strings.TrimSpace(dec.Status), "valid") && strings.Contains(strings.ToLower(dec.Reason), "live verification") {
		return true
	}
	if !dec.Allowed && strings.Contains(strings.ToLower(dec.Reason), "live verification") {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(dec.Status)) {
	case "missing", "upload_required":
		return uploadErr != nil || !claude.HasUsableAuth()
	}
	return false
}

func recoveryReason(dec orchestrator.AuthDecision, uploadErr error) string {
	if uploadErr != nil {
		return "Local Claude credentials were not accepted by the server: " + uploadErr.Error()
	}
	if dec.Reason != "" {
		return dec.Reason
	}
	return "Claude credentials are missing from the orchestrator."
}

func recoverClaudeAuth(ctx context.Context, cfg *config.Config, client *orchestrator.Client, logger *slog.Logger, reason string) error {
	if !term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stdout.Fd())) || !term.IsTerminal(int(os.Stderr.Fd())) {
		return errAuthRecoveryNonInteractive
	}
	fmt.Fprintln(os.Stderr)
	if strings.TrimSpace(reason) != "" {
		fmt.Fprintln(os.Stderr, "clx: "+reason)
	}
	fmt.Fprint(os.Stderr, "clx: Run `claude auth login`, upload credentials, and verify with the server now? [y/N] ")
	answer, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return fmt.Errorf("read auth recovery answer: %w", err)
	}
	answer = strings.ToLower(strings.TrimSpace(answer))
	if answer != "y" && answer != "yes" {
		return errAuthRecoveryDeclined
	}

	exit, err := claude.Run(ctx, cfg, []string{"auth", "login"})
	if err != nil {
		return fmt.Errorf("claude auth login: %w", err)
	}
	if exit != 0 {
		return fmt.Errorf("claude auth login exited with status %d", exit)
	}
	raw, _, err := claude.ReadAuthForUpload()
	if err != nil {
		return fmt.Errorf("read Claude credentials after login: %w", err)
	}
	if err := pushAuthCandidate(ctx, client, raw, logger); err != nil {
		return fmt.Errorf("upload Claude credentials after login: %w", err)
	}
	fmt.Fprintln(os.Stderr, "clx: Claude credentials uploaded and accepted by the server.")
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
		if len(resp.Auth) == 0 {
			return resp, nil, false
		}
		if err := claude.WriteAuth(resp.Auth); err != nil {
			return resp, err, false
		}
		logger.Debug("credentials.json updated from orchestrator", "concurrent", concurrent)
		return resp, nil, true
	default:
		return resp, nil, false
	}
}

func shouldWriteServerAuth(status string, auth []byte) bool {
	if len(auth) == 0 {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "outdated", "updated", "missing":
		return true
	default:
		return false
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
	if err := atomicWrite(dst, body, 0o644); err != nil {
		return false, err
	}
	return true, nil
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

func maybePostRunAuthUpload(client *orchestrator.Client, logger *slog.Logger, before map[string]authSnapshot) (string, ui.Tone) {
	raw, path, err := claude.ReadAuthForUpload()
	if err != nil || len(raw) == 0 || path == "" {
		return "not found", ui.ToneWarn
	}
	afterHash, afterRefresh := snapshotAuth(path)
	if afterHash == "" {
		return "not found", ui.ToneWarn
	}
	if prev, ok := before[path]; ok && prev.Hash == afterHash && prev.Refresh == afterRefresh {
		return "unchanged", ui.ToneOK
	}
	// 15s budget: a login during the session is the one credential mint the
	// fleet must not lose — give the upload room and make failure visible.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, err := client.AuthStore(ctx, raw)
	if err != nil {
		logger.Warn("post-run auth upload failed", "err", err)
		return "upload failed", ui.ToneFail
	}
	if resp != nil && len(resp.Auth) > 0 {
		if werr := claude.WriteAuth(resp.Auth); werr != nil {
			logger.Warn("post-run auth write-back failed", "err", werr)
			return "write-back failed", ui.ToneFail
		}
	}
	prev := before[path]
	logger.Debug("post-run auth uploaded", "path", path, "hash_changed", prev.Hash != afterHash, "refresh_changed", prev.Refresh != afterRefresh)
	return "uploaded", ui.ToneOK
}

func markOfflineHealth(dots []ui.HealthDot) {
	for i := range dots {
		if dots[i].Name == "api" || dots[i].Name == "auth" {
			dots[i].Tone = ui.ToneWarn
		}
	}
}

func themeFromConfig(cfg *config.Config) string {
	if cfg == nil || cfg.EngineOptions.AdminThemeHint == nil {
		return ""
	}
	return *cfg.EngineOptions.AdminThemeHint
}

func updateCaps(cfg *config.Config, minimal bool) ui.Caps {
	caps := ui.DetectCaps(themeFromConfig(cfg))
	if minimal {
		return ui.MinimalCaps(caps)
	}
	return caps
}

// concurrentNote picks the right "Concurrent" row text for the boot screen.
// The note makes clear that only managed writes are paused; credential
// freshness is still checked before launch.
func concurrentNote(concurrent bool, dec orchestrator.AuthDecision) string {
	if !concurrent {
		return ""
	}
	if dec.LocalUsable {
		return "Managed content sync paused; auth freshness remains active."
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
// Returns the post-install Claude version when an install actually ran,
// empty otherwise. The lifecycle independently re-measures the installed
// version for the exit footer.
func maybeEnsureClaude(ctx context.Context, cfg *config.Config, auth *orchestrator.AuthRetrieveResponse, concurrent, minimal bool, logger *slog.Logger) string {
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
	if current == target {
		logger.Debug("claude auto-update skipped: already at target", "version", current)
		return ""
	}
	if claude.IsDowngrade(current, target) {
		logger.Debug("skipping downgrade", "current", current, "target", target)
		return ""
	}
	caps := updateCaps(cfg, minimal)
	fmt.Fprintln(os.Stderr, ui.UpdateProgress(caps, "clx", "claude", current, target))
	if err := claude.EnsureClaude(ctx, target, v.ClientVersionEnforceExact, logger); err != nil {
		logger.Warn("claude auto-update skipped", "err", err, "target", target, "current", current)
		fmt.Fprintln(os.Stderr, ui.UpdateFailure(caps, "clx", "claude", target, err))
		return ""
	}
	post := strings.TrimSpace(claude.Version(ctx))
	if post == "" || post == "unknown" {
		post = target
	}
	fmt.Fprintln(os.Stderr, ui.UpdateComplete(caps, "clx", "claude", post, false))
	return post
}

func maybeEnsureWrapper(ctx context.Context, cfg *config.Config, auth *orchestrator.AuthRetrieveResponse, current string, concurrent, minimal bool, logger *slog.Logger) {
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
	caps := updateCaps(cfg, minimal)
	fmt.Fprintln(os.Stderr, ui.UpdateProgress(caps, "clx", "wrapper", current, target))
	exe, err := update.SelfUpdateFrom(ctx, cfg, *v.WrapperURL, *v.WrapperSHA256, target, logger)
	if err != nil {
		logger.Warn("wrapper auto-update skipped", "err", err, "target", target, "current", current)
		fmt.Fprintln(os.Stderr, ui.UpdateFailure(caps, "clx", "wrapper", target, err))
		return
	}
	fmt.Fprintln(os.Stderr, ui.UpdateComplete(caps, "clx", "wrapper", target, true))
	if err := update.ReExecAfterUpdate(exe, update.SnapshottedArgv); err != nil {
		logger.Warn("wrapper restart after update failed", "err", err)
		fmt.Fprintln(os.Stderr, ui.UpdateFailure(caps, "clx", "wrapper", target, err))
	}
}

func buildSessionCounts(fs *orchestrator.FleetSessions) *summary.SessionCounts {
	if fs == nil {
		return nil
	}
	return &summary.SessionCounts{
		LocalNow: int64(ipc.CountActive("clx")),
		FleetNow: fs.Now,
		Today:    fs.Today,
		Month:    fs.Month,
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

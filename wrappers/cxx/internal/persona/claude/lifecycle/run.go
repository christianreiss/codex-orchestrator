// Package lifecycle orchestrates the startup sequence for a single `clx run`:
// FQDN guard → lock → bundle (auth + agents + settings in one POST) → decide
// → boot screen → pre-exec → Claude → post-exec auth upload → exit footer.
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
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/observability/tracing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/peer"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/update"
)

type Options struct {
	Config       *config.Config
	ExtraArgs    []string
	SkipAuthSync bool
	SkipBoot     bool
	Minimal      bool
	Headless     bool
	// Resumed labels an interactive resume distinctly in the portal timeline.
	Resumed             bool
	AllowConcurrentSync bool
	// SyncOnly performs the managed-content half of a run and stops: bootstrap,
	// skills, collections, peer reconciliation, then the same auth gate an
	// interactive run applies — but no PreExec, no portal session, no Claude.
	// This is what `clx sync`, the post-update pass, and the cron tick use to
	// converge fleet-managed content without launching an engine.
	SyncOnly       bool
	WrapperVersion string
	Logger         *slog.Logger
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

var wrapperSelfUpdate = update.SelfUpdateFrom
var wrapperReExec = update.ReExecAfterUpdate

const authLoginRequiredReason = "Claude authentication required; run `clx auth login` interactively."

var errAuthRecoveryNonInteractive = errors.New(authLoginRequiredReason)
var lifecycleIsTerminal = term.IsTerminal

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

func portalInvocationKind(headless bool) string {
	if headless {
		return "execute"
	}
	return "interactive"
}

func portalExit(exitCode int, runErr error) (string, string) {
	if exitCode == 0 && runErr == nil {
		return "completed", "Agent completed"
	}
	return "failed", fmt.Sprintf("Agent exited with code %d", exitCode)
}

func Run(ctx context.Context, opts Options) (exitCode int, retErr error) {
	// SkipAuthSync is the only thing that turns a sync-only pass into a silent
	// no-op that still reports success. Refuse the combination outright rather
	// than let a caller believe content was written.
	if opts.SyncOnly && opts.SkipAuthSync {
		return 2, errors.New("sync-only lifecycle cannot skip the managed sync")
	}

	cfg := opts.Config
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	// Optional tracing, off unless CXX_OTEL_TRACES_ENABLED is set. Scoped to a
	// lifecycle so `clx cron`, `clx update` and friends pay nothing. Registered
	// first so its defers unwind last: the run span closes after the auth
	// session, and the flush happens after that. Neither defer touches exitCode
	// or retErr — they only read the settled values.
	stopTracing := tracing.Init(ctx, tracing.Options{
		Engine:  "claude",
		Version: currentWrapperVersion(opts, cfg),
		Logger:  logger,
	})
	defer stopTracing()
	ctx, runSpan := tracing.Start(ctx, "cxx.lifecycle.run",
		tracing.String("wrapper.engine", "claude"),
		tracing.Bool("wrapper.headless", opts.Headless),
		tracing.Bool("wrapper.minimal", opts.Minimal),
		tracing.Bool("wrapper.resumed", opts.Resumed),
	)
	defer func() {
		runSpan.SetInt("wrapper.exit_code", exitCode)
		runSpan.Fail(retErr)
		runSpan.End()
	}()

	// Refuse a cloned or mis-deployed host before acquiring a run lock or
	// making any orchestrator request. PreExec repeats this immediately before
	// spawning Claude as defense-in-depth.
	if err := claude.GuardFQDN(cfg); err != nil {
		return 1, err
	}

	// Every lifecycle holds a shared auth lease without serializing interactive
	// sessions. An insecure invocation records purge intent; whichever process
	// proves it is the last active lease holder performs the purge, regardless of
	// owner/secondary exit order.
	authSession, sessionErr := claude.StartAuthSession(!cfg.Host.Secure)
	if sessionErr != nil {
		return 1, fmt.Errorf("start Claude auth session: %w", sessionErr)
	}
	defer func() {
		purged, cleanupErr := authSession.CloseAndPurgeIfLast()
		if cleanupErr != nil {
			exitCode = 1
			retErr = errors.Join(retErr, fmt.Errorf("finalize Claude auth session: %w", cleanupErr))
			return
		}
		if purged {
			logger.Debug("purged insecure Claude credentials after last active session")
		}
	}()

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
	runSpan.SetBool("wrapper.concurrent", concurrent)

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
		if err := updateAuthSessionSecurity(authSession, authResp); err != nil {
			return 1, fmt.Errorf("persist API host security state: %w", err)
		}
		dec = decideAuth(authResp, authErr, authPath, cfg.Host.Secure)

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
					if err := updateAuthSessionSecurity(authSession, authResp); err != nil {
						return 1, fmt.Errorf("persist API host security state: %w", err)
					}
					dec = decideAuth(authResp, authErr, authPath, cfg.Host.Secure)
				}
			}
		}

		var authCandidateErr error
		if !concurrent && dec.Allowed && (dec.Status == "missing" || dec.Status == "upload_required") {
			if snap, rerr := claude.ReadAuthForUploadSnapshot(); rerr == nil && len(snap.Upload) > 0 {
				if err := pushAuthCandidate(ctx, client, snap, logger, authSession); err != nil {
					if errors.Is(err, claude.ErrAuthUploadBlockedByLogout) {
						logger.Debug("auth-candidate upload cancelled by explicit logout")
						dec = decideAuth(authResp, authErr, authPath, cfg.Host.Secure)
					} else {
						authCandidateErr = err
						logger.Warn("auth-candidate upload failed", "err", err)
					}
					if orchestrator.IsUnsafeRunnerUpdatedAuthError(err) {
						dec.Allowed = false
						dec.Status = "invalid"
						dec.Reason = "Runner returned unusable rotated Claude credentials; refusing the pre-refresh local token."
					} else if orchestrator.IsDefinitiveAuthCandidateRejection(err) {
						dec.Allowed = false
						dec.Status = "credential_rejected"
						dec.Reason = "Local Claude credentials were definitively rejected by live verification."
					}
				} else {
					authResp, authErr, authSynced, agentsSync, configSync, nativeSkillsSync, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
					if err := updateAuthSessionSecurity(authSession, authResp); err != nil {
						return 1, fmt.Errorf("persist API host security state: %w", err)
					}
					dec = decideAuth(authResp, authErr, authPath, cfg.Host.Secure)
				}
			} else if rerr != nil {
				authCandidateErr = rerr
			}
		}

		if needsInteractiveAuthRecovery(dec, authCandidateErr, localAuthFresh(authPath, cfg.Host.Secure)) {
			reason := safeLifecycleText(recoveryReason(dec, authCandidateErr), opts.Minimal)
			if opts.Headless {
				dec.Allowed = false
				dec.Reason = authLoginRequiredReason
			} else if err := recoverClaudeAuth(ctx, cfg, client, logger, reason, authSession); err != nil {
				logger.Warn("interactive Claude auth recovery failed", "err", err)
				dec.Allowed = false
				dec.Reason = err.Error()
			} else {
				authResp, authErr, authSynced, agentsSync, configSync, nativeSkillsSync, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
				if err := updateAuthSessionSecurity(authSession, authResp); err != nil {
					return 1, fmt.Errorf("persist API host security state: %w", err)
				}
				dec = decideAuth(authResp, authErr, authPath, cfg.Host.Secure)
			}
		}

		// PR-2: keep the local wrapper within range of the server-declared
		// target version when auto-update is enabled. Never blocks launch.
		// The Claude engine itself updates post-session (see maybeEnsureClaude
		// below) so a version bump never delays an interactive launch.
		if dec.Allowed {
			// A sync-only pass is already running the freshly installed binary —
			// `update` re-execs into it. Re-entering self-update from in here
			// would install and exec a second time from inside a sync, burning
			// restart depth for nothing. On the `cxx update` path this is load
			// bearing: that exec sets only CODEX_WRAPPER_RESTARTED, so the guard
			// inside maybeEnsureWrapper would still be cold for the claude leg.
			if !opts.SyncOnly {
				if err := maybeEnsureWrapper(ctx, cfg, authResp, currentWrapperVersion(opts, cfg), concurrent, opts.Minimal, logger, authSession); err != nil {
					return 1, fmt.Errorf("restart after wrapper update: %w", err)
				}
			}
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
	if dec.Allowed && !claude.IsValidLocalAuth(authPath) {
		dec.Allowed = false
		dec.Reason = authLoginRequiredReason
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
	}
	if !opts.SkipBoot {
		if opts.Minimal {
			ui.PrintMinimalScreen(os.Stderr, state)
		} else {
			ui.PrintBootScreen(os.Stderr, state)
		}
	}
	// Claude has no quota bars in this orchestrator (see clx/internal/persona/claude/ui/screen.go);
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

	// A sync-only pass has now done everything asked of it: the boot screen is
	// rendered above and the trust gate has had its say. Stop before the portal
	// session and PreExec so a sync never opens a phantom session row.
	if opts.SyncOnly {
		return 0, nil
	}

	before := snapshotAuthGeneration()

	restoreInheritedPortalEnv := agentportal.ScrubEnvironment()
	defer restoreInheritedPortalEnv()
	upstreamSessionID := ""
	if opts.Resumed {
		upstreamSessionID = agentportal.ExplicitResumeSessionID(opts.ExtraArgs)
	}
	portalSession, portalErr := agentportal.Start(ctx, cfg, agentportal.StartInput{
		Engine:            config.EngineClaude,
		InvocationKind:    portalInvocationKind(opts.Headless),
		Resumed:           opts.Resumed,
		UpstreamSessionID: upstreamSessionID,
	})
	if portalErr != nil {
		logger.Warn("agent portal registration unavailable; continuing local session", "err", portalErr)
	}
	closePortal := func(string, string) {}
	if portalSession != nil {
		portalBroker, brokerErr := portalSession.StartBroker(ctx)
		if brokerErr != nil {
			logger.Warn("agent portal local broker unavailable; continuing without #afk relay", "err", brokerErr)
		}
		restorePortalEnv := func() {}
		if portalBroker != nil {
			restorePortalEnv = portalBroker.ActivateEnvironment()
		}
		stopPortalHeartbeat := portalSession.StartHeartbeat(ctx)
		portalClosed := false
		closePortal = func(status, summaryText string) {
			if portalClosed {
				return
			}
			portalClosed = true
			stopPortalHeartbeat()
			closeCtx, closeCancel := context.WithTimeout(context.Background(), 4*time.Second)
			if err := portalSession.Heartbeat(closeCtx, "", "close"); err != nil {
				logger.Warn("agent portal relay close failed", "err", err)
			}
			closeCancel()
			if portalBroker != nil {
				if err := portalBroker.Close(); err != nil {
					logger.Warn("agent portal local broker cleanup failed", "err", err)
				}
			}
			restorePortalEnv()
			if err := portalSession.Finish(status, summaryText); err != nil {
				logger.Warn("agent portal finalization failed", "err", err)
			}
		}
		defer func() {
			status, summaryText := portalExit(exitCode, retErr)
			closePortal(status, summaryText)
		}()
	}

	started := time.Now()
	launchArgs := guardRootPermissionMode(opts.ExtraArgs, logger)
	exitCode, _, runErr := claude.RunCaptureWithAuthSession(ctx, cfg, launchArgs, authSession)
	duration := time.Since(started)
	portalStatus, portalSummary := portalExit(exitCode, runErr)
	closePortal(portalStatus, portalSummary)

	// Post-session Claude engine update (best-effort). Runs after the user's
	// work is done instead of before it starts, so a version bump never
	// delays an interactive launch — the new version lands on the next run.
	if dec.Allowed {
		maybeEnsureClaude(ctx, cfg, client, authResp, currentWrapperVersion(opts, cfg), concurrent, opts.Minimal, logger)
	}

	authStatus, authTone := maybePostRunAuthUpload(client, logger, before, authSession)
	if authTone == ui.ToneFail {
		if exitCode == 0 {
			exitCode = 1
		}
		runErr = errors.Join(runErr, fmt.Errorf("Claude auth finalization failed: %s", authStatus))
	}

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

func updateAuthSessionSecurity(session *claude.AuthSession, resp *orchestrator.AuthRetrieveResponse) error {
	secure, known := resp.HostSecurity()
	if !known || session == nil {
		return nil
	}
	return session.SetPurgeOnLastExit(!secure)
}

func decideAuth(resp *orchestrator.AuthRetrieveResponse, authErr error, authPath string, secure bool) orchestrator.AuthDecision {
	dec := orchestrator.Decide(resp, authPath, secure, localProbe)
	logoutHold, logoutErr := claude.LogoutIntentActive()
	if logoutErr != nil {
		dec.Allowed = false
		dec.LocalUsable = false
		dec.Reason = "Cannot verify local Claude logout intent: " + logoutErr.Error()
		return dec
	}
	if logoutHold {
		dec.Allowed = false
		dec.LocalUsable = false
		dec.Reason = "Claude is explicitly logged out on this host; run `clx auth login` to authenticate again."
		return dec
	}
	if resp != nil && resp.CandidateCredentialRejected && !localMatchesVerifiedCanonical(resp, authPath) {
		dec.Allowed = false
		dec.LocalUsable = false
		dec.Status = "credential_rejected"
		dec.Reason = "Local Claude credentials were definitively rejected by live verification."
		return dec
	}
	if resp != nil && resp.CandidateRejectedDefinitive && !localMatchesVerifiedCanonical(resp, authPath) {
		dec.Allowed = false
		dec.LocalUsable = false
		dec.Status = "credential_rejected"
		dec.Reason = "Local Claude credentials were definitively rejected by live verification, and verified canonical repair was not applied."
		return dec
	}
	if orchestrator.IsUnsafeRunnerUpdatedAuthError(authErr) {
		dec.Allowed = false
		dec.LocalUsable = false
		dec.Reason = "The auth runner rotated credentials but the replacement is not safe to use yet; refusing to launch with the superseded local token. Retry after the runner is healthy."
		return dec
	}
	if failedCanonicalExplicitlyAllowsLocal(resp, authPath, secure) {
		// verification_state=failed names the selected server head, not a
		// different local candidate that the host just offered. A transient
		// runner/control-plane outage cannot turn that distinct runnable local
		// generation into a login prompt; keep it and retry the upload next run.
		dec.Allowed = true
		dec.LocalUsable = true
		dec.Reason = "Server canonical credentials failed verification; using distinct valid local credentials while upload retries."
		return dec
	}
	if authErr != nil && localAuthFresh(authPath, secure) &&
		(errors.Is(authErr, claude.ErrUnusableServerAuth) || isRetryableAuthSyncFailure(authErr)) {
		// A broken canonical envelope or temporary control-plane failure must not
		// strand a locally runnable Claude login. Keep that exact local generation
		// and retry fleet convergence after the session.
		dec.Allowed = true
		dec.LocalUsable = true
		if errors.Is(authErr, claude.ErrUnusableServerAuth) {
			dec.Reason = "Server returned unusable Claude credentials; using valid local credentials."
		} else {
			dec.Reason = "Auth sync temporarily unavailable; using valid local credentials."
		}
		return dec
	}
	if authErr != nil && resp != nil && !strings.EqualFold(strings.TrimSpace(resp.Status), "offline") {
		dec.Allowed = false
		dec.Reason = "Failed to apply authoritative Claude credentials: " + authErr.Error()
	}
	return dec
}

func localMatchesVerifiedCanonical(resp *orchestrator.AuthRetrieveResponse, authPath string) bool {
	if resp == nil || !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified") {
		return false
	}
	snap, err := claude.ReadAuthSnapshot(false)
	if err != nil || !snap.Usable {
		return false
	}
	if digest := strings.TrimSpace(resp.CanonicalDigest); digest != "" && snap.DigestForServer() == digest {
		return true
	}
	return len(resp.Auth) > 0 && claude.AuthMatchesCanonical(authPath, resp.Auth)
}

func failedCanonicalExplicitlyAllowsLocal(resp *orchestrator.AuthRetrieveResponse, authPath string, secure bool) bool {
	if resp == nil ||
		resp.CandidateCredentialRejected ||
		resp.CandidateRejectedDefinitive ||
		!strings.EqualFold(strings.TrimSpace(resp.VerificationState), "failed") ||
		resp.CandidateMatchesFailedHead == nil ||
		*resp.CandidateMatchesFailedHead ||
		!localAuthFresh(authPath, secure) {
		return false
	}
	return claude.HasUsableAuth()
}

func localAuthFresh(authPath string, secure bool) bool {
	if fresh, err := claude.IsFresh(authPath, claude.MaxAge24h); err == nil && fresh {
		return true
	}
	if secure {
		fresh, err := claude.IsFresh(authPath, claude.MaxAge7d)
		return err == nil && fresh
	}
	return false
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
	ctx, bootSpan := tracing.Start(ctx, "cxx.lifecycle.bootstrap",
		tracing.String("wrapper.engine", "claude"),
		tracing.Bool("wrapper.concurrent", concurrent),
	)
	defer bootSpan.End()

	authSnapshot := claude.AuthSnapshot{Path: authPath}
	digest := ""
	var (
		candidate         []byte
		candidatePossible bool
	)
	if snap, err := claude.ReadAuthForRetrieveSnapshot(); err == nil {
		authSnapshot = snap
		if snap.Usable {
			digest = snap.DigestForServer()
			candidatePossible = true
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		failure := &orchestrator.AuthRetrieveResponse{Status: "error", Message: err.Error()}
		return failure, fmt.Errorf("read authoritative Claude credentials: %w", err), false, summary.ResourceSync{}, summary.ResourceSync{}, summary.ResourceSync{}, nil
	}
	agentsDigest := fileDigest(agentsPath())
	configDigest := fileDigest(settingsPath())

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

	releaseBundleUpload := func() {}
	var (
		bundleCandidateSnapshot claude.AuthSnapshot
		bundleCandidateIntent   claude.LogoutIntentGeneration
		bundleCandidateSent     bool
	)
	if candidatePossible {
		snap, intent, release, err := claude.BeginChangedAuthUploadState()
		if errors.Is(err, os.ErrNotExist) {
			authSnapshot = claude.AuthSnapshot{Path: authPath}
			digest = ""
		} else if err != nil {
			failure := &orchestrator.AuthRetrieveResponse{Status: "error", Message: err.Error()}
			return failure, fmt.Errorf("stabilize Claude candidate for bundle: %w", err), false, summary.ResourceSync{}, summary.ResourceSync{}, summary.ResourceSync{}, nil
		} else {
			authSnapshot = snap
			digest = snap.DigestForServer()
			if !snap.Usable || intent.Blocks(snap) {
				release()
			} else {
				candidate = snap.Upload
				bundleCandidateSnapshot = snap
				bundleCandidateIntent = intent
				bundleCandidateSent = true
				releaseBundleUpload = release
			}
		}
	}

	// The live sync path. Attributes stay at the shape of the exchange —
	// whether a candidate was offered, what status came back — because the
	// request body and the response both carry credentials.
	bctx, syncSpan := tracing.Start(bctx, "cxx.sync.bootstrap",
		tracing.String("wrapper.engine", "claude"),
		tracing.Bool("wrapper.auth_candidate_offered", bundleCandidateSent),
	)
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
	if berr != nil {
		syncSpan.Fail(berr)
	} else if resp != nil && resp.Auth != nil {
		syncSpan.SetString("wrapper.auth_status", resp.Auth.Status)
	}
	syncSpan.End()
	releaseBundleUpload()

	if berr != nil && isBundleUnsupported(berr) {
		logger.Debug("bundle endpoint unsupported, falling back", "err", berr)
		bootSpan.SetBool("wrapper.bundle_fallback", true)
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
	if authResp.Host == nil && resp.Host != nil {
		authResp.Host = resp.Host
	}
	if bundleCandidateSent && bundleCandidateIntent.Exists && authResp.AuthCandidateAccepted() {
		acknowledged, err := claude.ClearLogoutIntentIfUnchanged(bundleCandidateSnapshot.Generation, bundleCandidateIntent)
		if err != nil {
			return authResp, fmt.Errorf("acknowledge accepted Claude bundle candidate: %w", err), false, summary.ResourceSync{}, summary.ResourceSync{}, summary.ResourceSync{}, resp.Sessions
		}
		if !acknowledged {
			logger.Debug("Claude auth or logout intent changed after accepted bundle candidate; preserving newer local state")
		}
	}
	authSynced := false
	if shouldWriteServerAuth(authResp.Status, authResp.Auth) && claude.ServerAuthMayReplace(
		authSnapshot,
		authResp.Auth,
		authResp.CanonicalLastRefresh,
		authResp.VerificationState,
		authResp.CandidateRejectedDefinitive,
	) {
		applied, err := claude.WriteVerifiedServerAuthIfCurrentWithDigest(
			authResp.Auth,
			authResp.CanonicalDigest,
			authResp.VerificationState,
			authSnapshot.Generation,
		)
		if err != nil {
			logger.Warn("credentials.json write from bundle failed", "err", err)
			return authResp, err, false, summary.ResourceSync{}, summary.ResourceSync{}, summary.ResourceSync{}, resp.Sessions
		} else if applied {
			authSynced = true
			logger.Debug("credentials.json updated from /sync/bootstrap", "concurrent", concurrent)
		} else {
			logger.Debug("credentials.json changed while /sync/bootstrap was in flight; preserving local generation")
			if err := claude.BlockedCanonicalWriteError(authSnapshot, authResp.Auth, authResp.CandidateRejectedDefinitive); err != nil {
				return authResp, err, false, summary.ResourceSync{}, summary.ResourceSync{}, summary.ResourceSync{}, resp.Sessions
			}
			markLogoutRecovery(authResp)
		}
	}
	if bundleCandidateSent {
		if err := neutralizeRejectedSupersededBundleCandidate(authResp, bundleCandidateSnapshot); err != nil {
			return authResp, err, false, summary.ResourceSync{}, summary.ResourceSync{}, summary.ResourceSync{}, resp.Sessions
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
		updated, err := applyClaudeArtifactsResult(ctx, resp.ClaudeArtifacts, logger)
		configSync.Updated = configSync.Updated || updated
		configSync.Err = errors.Join(configSync.Err, err)
		// On-disk skills → ~/.claude/skills/<slug>/SKILL.md (Claude Code's native
		// skill layout; it can't read skills over MCP like codex does). Keep this
		// outcome on the skills marker rather than masking it as config health.
		nativeSkillsSync = applyBundleClaudeSkills(ctx, resp.ClaudeSkills, logger)
	}
	return authResp, nil, authSynced, agentsSync, configSync, nativeSkillsSync, resp.Sessions
}

func neutralizeRejectedSupersededBundleCandidate(
	resp *orchestrator.AuthRetrieveResponse,
	submitted claude.AuthSnapshot,
) error {
	if resp == nil ||
		(!resp.CandidateCredentialRejected &&
			!resp.CandidateRejectedDefinitive &&
			resp.CandidateMatchesFailedHead == nil) {
		return nil
	}
	latest, err := claude.ReadAuthSnapshot(false)
	if err != nil || !latest.Usable || latest.Generation == submitted.Generation {
		return nil
	}
	intent, err := claude.CurrentLogoutIntentGeneration()
	if err != nil {
		return fmt.Errorf("inspect Claude logout intent after candidate response: %w", err)
	}
	if intent.Exists || claude.SameCredentialPair(latest.Raw, submitted.Raw) {
		// Logout remains authoritative, and a byte-different rewrite of the same
		// provider credential pair is still the exact rejected credential.
		return nil
	}

	// Candidate verdicts are generation-bound. A different runnable native
	// login completed while A was in flight, so neither A's rejection nor its
	// comparison with the failed server head says anything about C.
	resp.Status = "upload_required"
	resp.Message = "Local Claude credentials changed while candidate verification was in flight; upload the newer generation."
	resp.VerificationState = ""
	resp.CandidateCredentialRejected = false
	resp.CandidateRejectedDefinitive = false
	resp.CandidateMatchesFailedHead = nil
	resp.CandidateResult = ""
	resp.Auth = nil
	return nil
}

func legacySyncPath(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, concurrent bool, authPath string) (*orchestrator.AuthRetrieveResponse, error, bool, summary.ResourceSync, summary.ResourceSync) {
	// Labelled as a fallback on purpose: against a current orchestrator this
	// branch is unreachable (it needs isBundleUnsupported), so a span appearing
	// here means the host is talking to an old server, not that the sync is
	// slow. Do not read it as the normal path.
	ctx, span := tracing.Start(ctx, "cxx.sync.legacy_fallback",
		tracing.String("wrapper.engine", "claude"),
		tracing.Bool("wrapper.fallback", true),
	)
	defer span.End()

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

func applyBundleClaudeSkills(ctx context.Context, items []orchestrator.CollectionItem, logger *slog.Logger) summary.ResourceSync {
	if items == nil {
		return summary.ResourceSync{}
	}
	updated, err := applyClaudeSkillsResult(ctx, items, logger)
	return summary.ResourceSync{Checked: true, Updated: updated, Err: err}
}

func isBundleUnsupported(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, " -> 404") || strings.Contains(s, " -> 501") || strings.Contains(s, " -> 405")
}

func pushAuthCandidate(ctx context.Context, client *orchestrator.Client, snap claude.AuthSnapshot, logger *slog.Logger, session *claude.AuthSession) error {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, current, err := storeChangedAuthCandidate(cctx, client)
	if err != nil {
		return err
	}
	if err := updateAuthSessionSecurity(session, resp); err != nil {
		return fmt.Errorf("persist API host security state after auth candidate: %w", err)
	}
	if current.Generation != snap.Generation {
		logger.Debug("auth candidate changed before store; uploading latest generation")
	}
	snap = current
	if resp != nil && len(resp.Auth) > 0 && claude.ServerAuthMayReplace(
		snap,
		resp.Auth,
		resp.CanonicalLastRefresh,
		resp.VerificationState,
		resp.CandidateRejectedDefinitive,
	) {
		applied, werr := claude.WriteVerifiedServerAuthIfCurrentWithDigest(
			resp.Auth,
			resp.CanonicalDigest,
			resp.VerificationState,
			snap.Generation,
		)
		if werr != nil {
			return fmt.Errorf("auth write-back after upload: %w", werr)
		}
		if !applied {
			if blockedErr := claude.BlockedCanonicalWriteError(snap, resp.Auth, resp.CandidateRejectedDefinitive); blockedErr != nil {
				return fmt.Errorf("auth write-back after upload: %w", blockedErr)
			}
			logger.Debug("auth changed during upload; preserving newer local generation")
		}
	}
	return nil
}

// storeChangedAuthCandidate is the single automatic AuthStore transaction.
// The auth-file and logout-marker lease remains held for the full network call,
// so an explicit logout orders wholly before or after it. A marker for an older
// generation is acknowledged only after the server accepts this exact upload.
func storeChangedAuthCandidate(ctx context.Context, client *orchestrator.Client) (*orchestrator.AuthRetrieveResponse, claude.AuthSnapshot, error) {
	snap, intent, releaseUpload, err := claude.BeginChangedAuthUploadState()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && claude.HasLogoutIntent() {
			return nil, claude.AuthSnapshot{}, claude.ErrAuthUploadBlockedByLogout
		}
		return nil, claude.AuthSnapshot{}, err
	}
	defer releaseUpload()
	if intent.Blocks(snap) {
		releaseUpload()
		return nil, snap, claude.ErrAuthUploadBlockedByLogout
	}
	resp, err := client.AuthStore(ctx, snap.Upload)
	releaseUpload()
	if err != nil {
		return resp, snap, err
	}
	if !intent.Exists {
		return resp, snap, nil
	}
	if !resp.AuthCandidateAccepted() {
		return resp, snap, fmt.Errorf("%w: server did not accept the pending login generation", claude.ErrAuthUploadBlockedByLogout)
	}
	acknowledged, err := claude.ClearLogoutIntentIfUnchanged(snap.Generation, intent)
	if err != nil {
		return resp, snap, fmt.Errorf("acknowledge accepted Claude auth candidate: %w", err)
	}
	if !acknowledged {
		return resp, snap, claude.ErrAuthUploadBlockedByLogout
	}
	return resp, snap, nil
}

func needsInteractiveAuthRecovery(dec orchestrator.AuthDecision, uploadErr error, localUsable bool) bool {
	if orchestrator.IsUnsafeRunnerUpdatedAuthError(uploadErr) {
		// The pre-refresh token may already be spent, so it must never launch.
		// A fresh interactive provider login is nevertheless the safe recovery.
		return true
	}
	if orchestrator.IsDefinitiveAuthCandidateRejection(uploadErr) {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(dec.Status), "valid") && strings.Contains(strings.ToLower(dec.Reason), "live verification") {
		return true
	}
	if !dec.Allowed && strings.Contains(strings.ToLower(dec.Reason), "live verification") {
		return true
	}
	if strings.Contains(strings.ToLower(dec.Reason), "explicitly logged out") {
		return true
	}
	if localUsable {
		// Upload/control-plane convergence is best-effort when Claude already has
		// runnable local credentials. Do not turn a retryable store failure into
		// an unnecessary second login.
		return false
	}
	switch strings.ToLower(strings.TrimSpace(dec.Status)) {
	case "valid", "current", "ok", "unchanged", "updated", "outdated", "missing", "upload_required", "offline", "error", "credential_rejected", "":
		return !authDecisionIsPolicyDenial(dec)
	}
	return false
}

func authDecisionIsPolicyDenial(dec orchestrator.AuthDecision) bool {
	if dec.NeedsApprovalPoll {
		return true
	}
	reason := strings.ToLower(dec.Reason)
	for _, marker := range []string{
		"api disabled",
		"invalid api key",
		"engine disabled",
		"installation id mismatch",
		"ip binding mismatch",
		"reverse dns mismatch",
		"insecure host approval",
	} {
		if strings.Contains(reason, marker) {
			return true
		}
	}
	return false
}

func isRetryableAuthSyncFailure(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var httpErr *orchestrator.HTTPError
	if errors.As(err, &httpErr) {
		switch strings.ToLower(strings.TrimSpace(httpErr.Code)) {
		case "api_disabled",
			"engine_disabled",
			"invalid_api_key",
			"installation_id_mismatch",
			"ip_mismatch",
			"reverse_dns_mismatch",
			"insecure_pending",
			"insecure_denied",
			"runner_updated_auth_invalid":
			return false
		}
		return httpErr.StatusCode == 408 || httpErr.StatusCode == 429 || httpErr.StatusCode >= 500
	}
	// Transport/DNS/TLS failures have no HTTP response and are retryable. Stable
	// host-policy denials arrive as typed HTTPError values above.
	return true
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

func recoverClaudeAuth(ctx context.Context, cfg *config.Config, client *orchestrator.Client, logger *slog.Logger, reason string, session *claude.AuthSession) error {
	if !lifecycleIsTerminal(int(os.Stdin.Fd())) || !lifecycleIsTerminal(int(os.Stdout.Fd())) || !lifecycleIsTerminal(int(os.Stderr.Fd())) {
		return errAuthRecoveryNonInteractive
	}
	fmt.Fprintln(os.Stderr)
	if strings.TrimSpace(reason) != "" {
		fmt.Fprintln(os.Stderr, "clx: "+reason)
	}
	fmt.Fprintln(os.Stderr, "clx: Starting `claude auth login` to restore authentication.")

	beforeLogin, beforeLoginErr := claude.ReadAuthSnapshot(false)
	if beforeLoginErr != nil && !errors.Is(beforeLoginErr, os.ErrNotExist) {
		return fmt.Errorf("snapshot Claude credentials before login: %w", beforeLoginErr)
	}
	beforeIntent, err := claude.CurrentLogoutIntentGeneration()
	if err != nil {
		return fmt.Errorf("snapshot Claude logout intent before login: %w", err)
	}
	exit, err := claude.RunWithAuthSession(ctx, cfg, []string{"auth", "login"}, session)
	if err != nil {
		return fmt.Errorf("claude auth login: %w", err)
	}
	if exit != 0 {
		return fmt.Errorf("claude auth login exited with status %d", exit)
	}
	snap, intent, releaseUpload, err := claude.BeginAuthUploadState()
	if err != nil {
		return fmt.Errorf("read Claude credentials after login: %w", err)
	}
	defer releaseUpload()
	secureHost := cfg != nil && cfg.Host.Secure
	if !snap.Usable || !localAuthFresh(snap.Path, secureHost) {
		releaseUpload()
		return errors.New("claude auth login completed without fresh runnable local credentials")
	}
	if beforeLoginErr == nil && beforeIntent.Blocks(beforeLogin) &&
		(snap.Generation == beforeLogin.Generation || claude.SameCredentialPair(snap.Raw, beforeLogin.Raw)) {
		releaseUpload()
		return errors.New("claude auth login did not replace the explicitly logged-out credential pair")
	}
	resp, err := client.AuthStore(ctx, snap.Upload)
	releaseUpload()
	if err != nil {
		if isRetryableAuthSyncFailure(err) {
			acknowledged, clearErr := claude.ClearLogoutIntentIfUnchanged(snap.Generation, intent)
			if clearErr != nil {
				return fmt.Errorf("acknowledge fresh Claude login after deferred upload: %w", clearErr)
			}
			if !acknowledged || !localAuthFresh(snap.Path, secureHost) {
				return errors.New("Claude credentials or logout intent changed while login upload was in flight")
			}
			logger.Warn("Claude login succeeded but server upload is deferred", "err", err)
			fmt.Fprintln(os.Stderr, "clx: Local Claude login is ready; server upload will retry on the next sync.")
			return nil
		}
		return fmt.Errorf("upload Claude credentials after login: %w", err)
	}
	if err := updateAuthSessionSecurity(session, resp); err != nil {
		return fmt.Errorf("persist API host security state: %w", err)
	}
	if resp != nil && strings.EqualFold(strings.TrimSpace(resp.VerificationState), "failed") {
		return errors.New("uploaded Claude credentials failed live verification")
	}
	if !resp.AuthCandidateAccepted() {
		// Canonical-win arbitration still has to converge local auth even though
		// it does not acknowledge this login. A different verified canonical may
		// safely clear a prior logout marker and continue; otherwise surface the
		// rejected recovery attempt instead of claiming success.
		if resp != nil && len(resp.Auth) > 0 && claude.ServerAuthMayReplace(
			snap,
			resp.Auth,
			resp.CanonicalLastRefresh,
			resp.VerificationState,
			resp.CandidateRejectedDefinitive,
		) {
			applied, writeErr := claude.WriteVerifiedServerAuthIfCurrentWithDigest(
				resp.Auth,
				resp.CanonicalDigest,
				resp.VerificationState,
				snap.Generation,
			)
			if writeErr != nil {
				if errors.Is(writeErr, claude.ErrUnusableServerAuth) && claude.HasUsableAuth() {
					return errors.New("the server rejected the new login and returned unusable canonical Claude credentials")
				}
				return fmt.Errorf("apply authoritative Claude credentials after rejected login: %w", writeErr)
			}
			if applied {
				fmt.Fprintln(os.Stderr, "clx: Submitted login was not accepted; restored the server's verified Claude credentials.")
				return nil
			}
			if !applied {
				if blockedErr := claude.BlockedCanonicalWriteError(snap, resp.Auth, resp.CandidateRejectedDefinitive); blockedErr != nil {
					return fmt.Errorf("apply authoritative Claude credentials after rejected login: %w", blockedErr)
				}
			}
		}
		return errors.New("the server did not accept the uploaded Claude credential generation")
	}
	unchanged, err := claude.ClearLogoutIntentIfUnchanged(snap.Generation, intent)
	if err != nil {
		return fmt.Errorf("acknowledge prior Claude logout intent: %w", err)
	}
	if !unchanged {
		return errors.New("Claude credentials or logout intent changed while login upload was in flight")
	}
	if resp != nil && len(resp.Auth) > 0 && claude.ServerAuthMayReplace(snap, resp.Auth, resp.CanonicalLastRefresh, resp.VerificationState, resp.CandidateRejectedDefinitive) {
		applied, err := claude.WriteVerifiedServerAuthIfCurrentWithDigest(
			resp.Auth,
			resp.CanonicalDigest,
			resp.VerificationState,
			snap.Generation,
		)
		if err != nil {
			if errors.Is(err, claude.ErrUnusableServerAuth) && claude.HasUsableAuth() {
				logger.Warn("accepted login returned unusable canonical write-back; preserving local login", "err", err)
				fmt.Fprintln(os.Stderr, "clx: Server write-back was unusable; keeping the accepted local Claude login.")
				return nil
			}
			return fmt.Errorf("apply accepted Claude credentials: %w", err)
		}
		if !applied {
			if blockedErr := claude.BlockedCanonicalWriteError(snap, resp.Auth, resp.CandidateRejectedDefinitive); blockedErr != nil {
				return fmt.Errorf("apply accepted Claude credentials: %w", blockedErr)
			}
		}
	}
	fmt.Fprintln(os.Stderr, "clx: Claude credentials uploaded and accepted by the server.")
	return nil
}

func syncAuthLegacy(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, concurrent bool) (*orchestrator.AuthRetrieveResponse, error, bool) {
	snap := claude.AuthSnapshot{}
	digest := ""
	if local, err := claude.ReadAuthForRetrieveSnapshot(); err == nil {
		snap = local
		if local.Usable {
			digest = local.DigestForServer()
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return &orchestrator.AuthRetrieveResponse{Status: "error", Message: err.Error()}, err, false
	}
	resp, err := client.AuthRetrieve(ctx, digest)
	if err != nil {
		return &orchestrator.AuthRetrieveResponse{Status: "offline", Message: err.Error()}, err, false
	}
	status := strings.ToLower(strings.TrimSpace(resp.Status))
	switch status {
	case "current", "ok", "valid", "unchanged", "":
		// A local login written after a durable logout marker still requires an
		// AuthStore acknowledgement even if the legacy digest-only retrieve says
		// current. Retrieve alone is not a server acceptance of that login event.
		if !claude.HasLogoutIntent() {
			return resp, nil, false
		}
		storeResp, current, storeErr := storeChangedAuthCandidate(ctx, client)
		if storeErr != nil {
			if errors.Is(storeErr, claude.ErrAuthUploadBlockedByLogout) {
				markLogoutRecovery(resp)
				return resp, nil, false
			}
			return resp, storeErr, false
		}
		return applyAcceptedLegacyStore(resp, storeResp, current, logger)
	case "outdated", "updated", "missing":
		if len(resp.Auth) == 0 {
			return resp, nil, false
		}
		mayReplace := claude.ServerAuthMayReplace(snap, resp.Auth, resp.CanonicalLastRefresh, resp.VerificationState, resp.CandidateRejectedDefinitive)
		if !mayReplace {
			if !snap.Usable || len(snap.Upload) == 0 {
				return resp, nil, false
			}
			// Old /auth retrieve responses have no candidate-rejection signal.
			// Offer the newer usable local generation once. Acceptance converges
			// server state; transient/security/rate failures preserve local; only
			// validation-style 400/422 authorizes the older verified canonical.
			storeResp, current, storeErr := storeChangedAuthCandidate(ctx, client)
			if current.Path != "" {
				snap = current
			}
			if storeErr == nil {
				return applyAcceptedLegacyStore(resp, storeResp, current, logger)
			}
			if errors.Is(storeErr, claude.ErrAuthUploadBlockedByLogout) {
				markLogoutRecovery(resp)
				return resp, nil, false
			}
			if orchestrator.IsUnsafeRunnerUpdatedAuthError(storeErr) {
				return resp, storeErr, false
			}
			if orchestrator.IsDefinitiveAuthCandidateRejection(storeErr) && !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified") {
				resp.Status = "credential_rejected"
				resp.CandidateCredentialRejected = true
				return resp, nil, false
			}
			if !orchestrator.IsDefinitiveAuthCandidateRejection(storeErr) || !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified") {
				logger.Warn("legacy auth candidate arbitration preserved newer local credentials", "err", storeErr)
				return resp, nil, false
			}
			resp.CandidateRejectedDefinitive = true
			mayReplace = true
		}
		if !mayReplace {
			return resp, nil, false
		}
		applied, err := claude.WriteVerifiedServerAuthIfCurrentWithDigest(
			resp.Auth,
			resp.CanonicalDigest,
			resp.VerificationState,
			snap.Generation,
		)
		if err != nil {
			return resp, err, false
		}
		if !applied {
			if err := claude.BlockedCanonicalWriteError(snap, resp.Auth, resp.CandidateRejectedDefinitive); err != nil {
				return resp, err, false
			}
			markLogoutRecovery(resp)
			return resp, nil, false
		}
		logger.Debug("credentials.json updated from orchestrator", "concurrent", concurrent)
		return resp, nil, true
	default:
		return resp, nil, false
	}
}

func applyAcceptedLegacyStore(retrieveResp, storeResp *orchestrator.AuthRetrieveResponse, snap claude.AuthSnapshot, logger *slog.Logger) (*orchestrator.AuthRetrieveResponse, error, bool) {
	if storeResp == nil {
		return retrieveResp, errors.New("legacy Claude auth store returned no response"), false
	}
	if storeResp.Host == nil && retrieveResp != nil {
		storeResp.Host = retrieveResp.Host
	}
	if len(storeResp.Auth) > 0 && claude.ServerAuthMayReplace(
		snap,
		storeResp.Auth,
		storeResp.CanonicalLastRefresh,
		storeResp.VerificationState,
		storeResp.CandidateRejectedDefinitive,
	) {
		applied, err := claude.WriteVerifiedServerAuthIfCurrentWithDigest(
			storeResp.Auth,
			storeResp.CanonicalDigest,
			storeResp.VerificationState,
			snap.Generation,
		)
		if err != nil {
			return storeResp, err, false
		}
		if !applied {
			if err := claude.BlockedCanonicalWriteError(snap, storeResp.Auth, storeResp.CandidateRejectedDefinitive); err != nil {
				return storeResp, err, false
			}
			markLogoutRecovery(storeResp)
		}
		return storeResp, nil, applied
	}
	if !storeResp.AuthCandidateAccepted() {
		return storeResp, errors.New("legacy Claude auth store did not accept the local candidate"), false
	}
	logger.Debug("legacy Claude auth candidate accepted")
	return storeResp, nil, false
}

func shouldWriteServerAuth(status string, auth []byte) bool {
	if len(auth) == 0 {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "valid", "outdated", "updated", "missing":
		return true
	default:
		return false
	}
}

func markLogoutRecovery(resp *orchestrator.AuthRetrieveResponse) {
	if resp == nil || !claude.HasLogoutIntent() {
		return
	}
	resp.Status = "missing"
	resp.Auth = nil
	resp.VerificationState = ""
	resp.Message = "Local Claude logout is authoritative; re-authentication is required."
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

func snapshotAuthGeneration() claude.AuthGeneration {
	snap, err := claude.ReadAuthSnapshot(false)
	if err != nil {
		return claude.AuthGeneration{}
	}
	return snap.Generation
}

func maybePostRunAuthUpload(client *orchestrator.Client, logger *slog.Logger, before claude.AuthGeneration, session *claude.AuthSession) (string, ui.Tone) {
	current, err := claude.ReadAuthSnapshot(false)
	if err != nil || !current.Usable {
		marked, markErr := claude.MarkLogoutIfCurrent(before)
		if markErr != nil {
			logger.Warn("record Claude logout failed", "err", markErr)
			return "logout tracking failed", ui.ToneFail
		}
		if marked {
			return "logged out", ui.ToneWarn
		}
		return "not found", ui.ToneWarn
	}
	if current.Generation == before {
		return "unchanged", ui.ToneOK
	}
	// 15s budget: a login during the session is the one credential mint the
	// fleet must not lose. storeChangedAuthCandidate holds the auth transaction
	// through AuthStore, so explicit logout orders wholly before or after it.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, snap, err := storeChangedAuthCandidate(ctx, client)
	if errors.Is(err, claude.ErrAuthUploadBlockedByLogout) {
		return "logged out", ui.ToneWarn
	}
	if err != nil || len(snap.Upload) == 0 {
		if err != nil {
			logger.Warn("post-run auth upload failed", "err", err)
		}
		return "upload failed", ui.ToneFail
	}
	if err := updateAuthSessionSecurity(session, resp); err != nil {
		logger.Warn("persist post-run API host security state failed", "err", err)
		return "security state failed", ui.ToneFail
	}
	if resp != nil && strings.EqualFold(strings.TrimSpace(resp.VerificationState), "failed") {
		logger.Warn("post-run auth response failed live verification")
		return "verification failed", ui.ToneFail
	}
	if resp != nil && len(resp.Auth) > 0 && claude.ServerAuthMayReplace(
		snap,
		resp.Auth,
		resp.CanonicalLastRefresh,
		resp.VerificationState,
		resp.CandidateRejectedDefinitive,
	) {
		applied, werr := claude.WriteVerifiedServerAuthIfCurrentWithDigest(
			resp.Auth,
			resp.CanonicalDigest,
			resp.VerificationState,
			snap.Generation,
		)
		if werr != nil {
			logger.Warn("post-run auth write-back failed", "err", werr)
			return "write-back failed", ui.ToneFail
		}
		if !applied {
			if blockedErr := claude.BlockedCanonicalWriteError(snap, resp.Auth, resp.CandidateRejectedDefinitive); blockedErr != nil {
				logger.Warn("post-run canonical response was not applied", "err", blockedErr)
				return "write-back blocked", ui.ToneFail
			}
			if logoutActive, logoutErr := claude.LogoutIntentActive(); logoutErr == nil && logoutActive {
				return "logged out", ui.ToneWarn
			}
			logger.Debug("post-run response was stale; preserved newer local Claude login")
			return "newer local kept", ui.ToneOK
		}
	} else if latest, latestErr := claude.ReadAuthSnapshot(false); latestErr != nil {
		logger.Warn("post-run auth generation recheck failed", "err", latestErr)
		return "generation check failed", ui.ToneFail
	} else if latest.Generation != snap.Generation {
		return "newer local kept", ui.ToneOK
	}
	logger.Debug("post-run auth uploaded", "path", snap.Path, "generation", snap.Generation.Digest)
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

// freshClientTarget re-resolves the engine target against the server right
// before installing it.
//
// The /auth snapshot the caller holds was fetched before the session started,
// so on a long session it names a release that is no longer current. /cron/check
// answers the same question in one round trip, and `probe` tells the server this
// is not the cron job so it leaves last_cron_check alone.
//
// Returns "" when the install should be skipped, and the caller's fallback
// unchanged when the server cannot be reached — an offline host still installs
// the pre-session target rather than nothing.
func freshClientTarget(ctx context.Context, client *orchestrator.Client, current, wrapperVersion, fallback string, fallbackExact bool, logger *slog.Logger) (string, bool) {
	if client == nil {
		return fallback, fallbackExact
	}
	check, err := client.CronCheck(ctx, orchestrator.CronCheckRequest{
		Engine:         "claude",
		ClientVersion:  current,
		WrapperVersion: wrapperVersion,
		Probe:          true,
	})
	if err != nil || check == nil {
		logger.Debug("claude target re-resolve failed; using pre-session target", "err", err, "target", fallback)
		return fallback, fallbackExact
	}
	switch check.Action {
	case "update":
		if check.TargetVersion == "" {
			return fallback, fallbackExact
		}
		if check.TargetVersion != fallback {
			logger.Debug("claude target moved during session", "pre_session", fallback, "fresh", check.TargetVersion)
		}
		return check.TargetVersion, check.EnforceExact
	case "no_update":
		// Already at the current target; the pre-session value was stale in the
		// other direction (an install happened elsewhere, or the pin moved down).
		return "", fallbackExact
	case "disable":
		// Auto-update was switched off mid-session. Removing the cron schedule
		// stays cron's job — this path only declines to install.
		logger.Debug("claude auto-update disabled by server; skipping post-session install")
		return "", fallbackExact
	}
	return fallback, fallbackExact
}

// maybeEnsureClaude repairs the local Claude CLI when the orchestrator
// reports auto-update enabled and the local version differs from target.
// Failures are logged but never fatal — a transient install error just
// leaves the current version in place for next time.
//
// Called after the Claude session has already exited (see Run), so the
// install never delays an interactive launch; the user only pays for it
// once, on their way out, and the new version takes effect on the next run.
//
// Returns the post-install Claude version when an install actually ran,
// empty otherwise. The lifecycle independently re-measures the installed
// version for the exit footer.
func maybeEnsureClaude(ctx context.Context, cfg *config.Config, client *orchestrator.Client, auth *orchestrator.AuthRetrieveResponse, wrapperVersion string, concurrent, minimal bool, logger *slog.Logger) string {
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
	enforceExact := v.ClientVersionEnforceExact
	current := strings.TrimSpace(claude.Version(ctx))
	// `auth` was retrieved before the session launched, so `target` is as old as
	// the session — an hour of work meant installing whatever was newest an hour
	// ago and reporting a fresh update on the very next launch, which read as a
	// stepwise updater walking releases one at a time. Re-resolve first.
	target, enforceExact = freshClientTarget(ctx, client, current, wrapperVersion, target, enforceExact, logger)
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
	if err := claude.EnsureClaude(ctx, target, enforceExact, logger); err != nil {
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

func maybeEnsureWrapper(ctx context.Context, cfg *config.Config, auth *orchestrator.AuthRetrieveResponse, current string, concurrent, minimal bool, logger *slog.Logger, authSession *claude.AuthSession) error {
	if concurrent || cfg == nil || auth == nil || auth.Versions == nil {
		return nil
	}
	v := auth.Versions
	if !v.AutoUpdateEnabled || v.WrapperVersion == nil || *v.WrapperVersion == "" {
		return nil
	}
	target := *v.WrapperVersion
	if current == target {
		return nil
	}
	if current != "" && current != "unknown" && !semverGT(target, current) {
		logger.Warn("skipping wrapper downgrade", "current", current, "target", target)
		return nil
	}
	if os.Getenv("CLAUDE_WRAPPER_RESTARTED") == "1" {
		logger.Warn("wrapper auto-update skipped after restart", "current", current, "target", target)
		return nil
	}
	if v.WrapperURL == nil || *v.WrapperURL == "" || v.WrapperSHA256 == nil || *v.WrapperSHA256 == "" {
		logger.Warn("wrapper auto-update skipped: missing artifact metadata", "current", current, "target", target)
		return nil
	}
	caps := updateCaps(cfg, minimal)
	fmt.Fprintln(os.Stderr, ui.UpdateProgress(caps, "clx", "wrapper", current, target))
	exe, err := wrapperSelfUpdate(ctx, cfg, *v.WrapperURL, *v.WrapperSHA256, target, logger)
	if err != nil {
		logger.Warn("wrapper auto-update skipped", "err", err, "target", target, "current", current)
		fmt.Fprintln(os.Stderr, ui.UpdateFailure(caps, "clx", "wrapper", target, err))
		return nil
	}
	fmt.Fprintln(os.Stderr, ui.UpdateComplete(caps, "clx", "wrapper", target, true))
	if authSession == nil {
		return errors.New("auth session unavailable for wrapper restart")
	}
	if err := authSession.FinalizeForReexec(); err != nil {
		return fmt.Errorf("finalize auth session before re-exec: %w", err)
	}
	if err := wrapperReExec(exe, update.SnapshottedArgv); err != nil {
		logger.Warn("wrapper restart after update failed", "err", err)
		fmt.Fprintln(os.Stderr, ui.UpdateFailure(caps, "clx", "wrapper", target, err))
		return err
	}
	return nil
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

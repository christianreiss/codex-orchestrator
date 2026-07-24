// Package lifecycle orchestrates the startup sequence for a single `cdx run`:
// lock → bundle (auth + agents + config in one POST) → decide → boot screen →
// pre-exec → Codex → post-exec auth upload → exit footer.
package lifecycle

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/peer"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ui"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/update"
)

type Options struct {
	Config       *config.Config
	ExtraArgs    []string
	SkipAuthSync bool
	SkipBoot     bool
	Minimal      bool
	// Headless marks a non-interactive invocation (`--execute`, cron). Such
	// runs must never open the interactive `codex login` recovery flow — they
	// fail closed instead. Distinct from SkipBoot, which only suppresses the
	// boot banner on an otherwise-interactive `cdx run`.
	Headless bool
	// AllowConcurrentSync honors the explicit escape hatch: when the run lock
	// is held, continue with normal sync writes instead of pausing managed writes.
	AllowConcurrentSync bool
	Logger              *slog.Logger
	WrapperVersion      string
}

// localProbe is the cached LocalAuthProbe binding to the codex package
// helpers; lets orchestrator.Decide work without importing codex.
var localProbe = orchestrator.LocalAuthProbe{
	IsValid:     codex.IsValidLocalAuth,
	IsFresh:     codex.IsFresh,
	LastRefresh: codex.LastRefreshOfFile,
}

var errAuthRecoveryDeclined = errors.New("Codex authentication was not refreshed")
var errAuthRecoveryNonInteractive = errors.New("Codex authentication refresh requires an interactive terminal")

type presentedError struct{ err error }

type authMaterializationError struct{ err error }

func (e *authMaterializationError) Error() string { return e.err.Error() }
func (e *authMaterializationError) Unwrap() error { return e.err }

func (e *presentedError) Error() string { return e.err.Error() }
func (e *presentedError) Unwrap() error { return e.err }

// ErrorWasPresented tells the command dispatcher that the responsive card
// already rendered this failure and a second raw line would be duplicate noise.
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

func decideAuth(resp *orchestrator.AuthRetrieveResponse, authErr error, authPath string, hostSecure bool) orchestrator.AuthDecision {
	dec := orchestrator.Decide(resp, authPath, hostSecure, localProbe)
	logoutHold, logoutErr := codex.LogoutIntentActive()
	if logoutErr != nil || logoutHold {
		dec.Allowed = false
		dec.LocalUsable = false
		dec.VerificationFailed = false
		dec.Reason = "Codex is explicitly logged out on this host; run `cdx login` to authenticate again."
		return dec
	}
	if orchestrator.IsUnsafeRunnerUpdatedAuthError(authErr) {
		dec.Allowed = false
		dec.LocalUsable = false
		dec.VerificationFailed = false
		dec.Reason = "The auth runner rotated credentials but returned an unusable replacement; refusing to launch with the superseded local token. Retry after the runner is healthy."
		return dec
	}
	var materializationErr *authMaterializationError
	if errors.As(authErr, &materializationErr) {
		dec.Allowed = false
		dec.LocalUsable = false
		dec.Reason = "Canonical credentials were accepted but could not be written locally: " + materializationErr.Error()
	}
	return dec
}

func finishAuthSession(logger *slog.Logger, sessionLease *codex.AuthSession, concurrent bool) error {
	removed, deferred, finishErr := codex.FinishAuthSession(sessionLease)
	if finishErr != nil {
		return finishErr
	}
	if deferred {
		logger.Info("insecure-host auth purge deferred while another cdx auth session remains active", "concurrent", concurrent)
	}
	if removed {
		logger.Info("purged local auth.json after insecure-host run")
	}
	return nil
}

func updateAuthSessionSecurity(resp *orchestrator.AuthRetrieveResponse) error {
	if resp == nil {
		return nil
	}
	var secure *bool
	if resp.Host != nil {
		value := resp.Host.Secure
		secure = &value
	}
	return codex.UpdateActiveAuthSessionSecurity(resp.Status, secure)
}

// Run executes one full Codex session and returns the upstream exit code.
func Run(ctx context.Context, opts Options) (exitCode int, runErr error) {
	cfg := opts.Config
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	// Concurrent-instance detection. If another instance holds the lock we
	// pause managed writes while still checking auth freshness and quota.
	concurrent := false
	lock, err := ipc.Acquire("cdx")
	if err != nil {
		if !errors.Is(err, ipc.ErrHeld) {
			return 1, err
		}
		if opts.AllowConcurrentSync {
			fmt.Fprintln(os.Stderr, "cdx: another session is active; concurrent sync explicitly enabled")
		} else {
			concurrent = true
			fmt.Fprintln(os.Stderr, "cdx: another session is active; managed content sync paused; auth freshness remains active")
		}
	} else {
		defer lock.Release()
	}

	// Runtime FQDN guard, run BEFORE any sync so a cloned/mis-deployed host
	// refuses up front — before bootstrap persists fleet auth/config, before a
	// self-update, and before peer.Reconcile (which can prune Claude state).
	// PreExec keeps a second copy as defense-in-depth. Honors
	// CODEX_ALLOW_FQDN_MISMATCH=1.
	if err := codex.GuardFQDN(cfg); err != nil {
		return 1, err
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
		agentsSync    summary.ResourceSync
		configSync    summary.ResourceSync
		skillsSync    summary.ResourceSync
		fleetSessions *orchestrator.FleetSessions
		dec           orchestrator.AuthDecision
	)
	authSessionLease, err := codex.StartAuthSession(cfg != nil && !cfg.Host.Secure)
	if err != nil {
		return 1, fmt.Errorf("acquire auth session lease: %w", err)
	}
	defer func() {
		if err := finishAuthSession(logger, authSessionLease, concurrent); err != nil {
			exitCode, runErr = mergeLifecycleFailure(exitCode, runErr, err)
		}
	}()

	if !opts.SkipAuthSync {
		authResp, authErr, authSynced, agentsSync, configSync, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
		dec = decideAuth(authResp, authErr, authPath, cfg.Host.Secure)

		// Insecure-host approval polling — block here until status flips or
		// the operator aborts. Re-bundle once on resolution.
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
					authResp, authErr, authSynced, agentsSync, configSync, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
					dec = decideAuth(authResp, authErr, authPath, cfg.Host.Secure)
				}
			}
		}

		// On missing/upload_required, push the local file via /sync/bootstrap
		// auth_candidate and re-decide.
		var authCandidateErr error
		if dec.Allowed && (dec.Status == "missing" || dec.Status == "upload_required") {
			if raw, rerr := codex.ReadAuth(); rerr == nil && len(raw) > 0 {
				if err := pushAuthCandidate(ctx, client, logger, false); err != nil {
					authCandidateErr = err
					logger.Warn("auth-candidate upload failed", "err", err)
					if orchestrator.IsUnsafeRunnerUpdatedAuthError(err) {
						dec.Allowed = false
						dec.LocalUsable = false
						dec.Reason = "The auth runner rotated credentials but returned an unusable replacement; refusing to launch with the superseded local token. Retry after the runner is healthy."
					}
				} else {
					authResp, authErr, authSynced, agentsSync, configSync, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
					dec = decideAuth(authResp, authErr, authPath, cfg.Host.Secure)
				}
			} else if rerr != nil {
				authCandidateErr = rerr
			}
		}

		// Interactive recovery: a live-verification failure (server reached the
		// provider and the canonical token is dead) or a missing/rejected
		// candidate means there is no usable credential anywhere on the fleet.
		// Offer to run `codex login` here, upload the freshly minted token, and
		// re-verify — the only fix for a rotated/expired refresh token. Headless
		// runs (cron, --execute) fail closed instead of opening a login flow.
		switch decideAuthRecovery(concurrent, opts.Headless, needsInteractiveAuthRecovery(dec, authCandidateErr, cfg.Host.Secure)) {
		case authRecoveryFailClosed:
			// Non-interactive callers (cron, --execute) must not open a
			// `codex login` prompt — fail closed with the underlying reason.
			reason := safeLifecycleText(recoveryReason(dec, authCandidateErr), opts.Minimal)
			logger.Warn("Codex auth recovery needed but caller is headless; failing closed", "reason", reason)
			dec.Allowed = false
			dec.Reason = reason
		case authRecoveryInteractive:
			reason := safeLifecycleText(recoveryReason(dec, authCandidateErr), opts.Minimal)
			if err := recoverCodexAuth(ctx, cfg, client, reason); err != nil {
				logger.Warn("interactive Codex auth recovery failed", "err", err)
				dec.Allowed = false
				dec.Reason = err.Error()
			} else {
				authResp, authErr, authSynced, agentsSync, configSync, fleetSessions = bootstrap(ctx, client, logger, concurrent, authPath)
				dec = decideAuth(authResp, authErr, authPath, cfg.Host.Secure)
			}
		}

		// PR-2: keep the local wrapper within range of the server-declared
		// target version when auto-update is enabled. Never blocks launch.
		// The Codex engine itself updates post-session (see maybeEnsureCodex
		// below) so a version bump never delays an interactive launch.
		if dec.Allowed {
			maybeEnsureWrapper(ctx, cfg, authResp, currentWrapperVersion(opts, cfg), concurrent, opts.Minimal, logger)
			if !concurrent {
				peer.Reconcile(ctx, cfg, authResp, opts.Minimal, logger)
			}
		}

		// Skills are MCP-served in v2; we still ping /skills to detect
		// fingerprint changes (lights the boot-screen "skills" dot) and
		// purge bash-era on-disk caches once per wrapper version so they
		// don't shadow MCP resolution. Both are best-effort.
		if !concurrent {
			skillsSync = syncSkills(ctx, client, logger)
			skillsSync = combineResourceSync(skillsSync, pruneLegacySkillDirs(wrapperVersion(cfg), logger))
		}
	}

	// Concurrent managed-sync-paused run: managed resource/update writes were
	// skipped, but auth freshness may have replaced the local file. Gate launch
	// on the current on-disk auth.json being usable. Applied
	// as the final verdict (before the boot screen renders it) so it can only
	// downgrade an allow to a refusal, never override a server-side hard stop.
	if concurrent {
		dec = orchestrator.ApplyConcurrent(dec, authPath, localProbe)
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
		SkillsSync:     skillsSync,
		ConfigSync:     combineResourceSync(agentsSync, configSync),
		AuthSynced:     authSynced,
		LaunchArgs:     opts.ExtraArgs,
		Sessions:       buildSessionCounts(fleetSessions),
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
	printBoot := func() {
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
	}

	// Refuse launch on auth decision.
	if !opts.SkipAuthSync && !dec.Allowed {
		printBoot()
		return 1, markPresented(fmt.Errorf("launch refused: %s", dec.Reason), opts)
	}

	// Block launch if hard-fail quota — unless the operator sets the documented
	// QUOTA_HARD_FAIL=0 escape hatch named in the refusal message itself. The
	// override was advertised in the message and the spec but never read; an
	// over-quota host could otherwise never launch.
	if authResp != nil && authResp.QuotaHardFail && authResp.ChatGPT != nil && state.QuotaBlock != "" {
		if os.Getenv("QUOTA_HARD_FAIL") == "0" {
			quotaMessage := applyQuotaHardFailOverride(&state)
			logger.Warn("quota over hard-fail limit; launching anyway because QUOTA_HARD_FAIL=0", "quota", quotaMessage)
		} else {
			state.ResultLabel = state.QuotaBlock
			state.ResultTone = ui.ToneFail
			printBoot()
			return 1, markPresented(fmt.Errorf("launch refused: %s", state.QuotaBlock), opts)
		}
	}

	teardown, err := codex.PreExec(ctx, cfg)
	if err != nil {
		state.ResultLabel = err.Error()
		state.ResultTone = ui.ToneFail
		printBoot()
		return 1, markPresented(err, opts)
	}
	defer teardown()

	printBoot()

	// Snapshot local auth before the run so we can detect post-run rotation.
	beforeHash, beforeRefresh := snapshotAuth(authPath)

	started := time.Now()
	launchArgs := launchArgsForAuth(opts.ExtraArgs, authResp)
	exitCode, _, runErr = codex.RunCapturePrepared(ctx, cfg, launchArgs)
	duration := time.Since(started)

	// Post-session Codex engine update (best-effort). Runs after the user's
	// work is done instead of before it starts, so a version bump never
	// delays an interactive launch — the new version lands on the next run.
	if dec.Allowed {
		maybeEnsureCodex(ctx, cfg, authResp, concurrent, opts.Minimal, logger)
	}

	// Post-exec auth upload (required when changed, 15s budget). A `codex login`
	// mid-run rotates tokens; the bounded auth+intent transaction pushes that
	// exact generation without racing explicit logout.
	authStatus, authTone, postAuthErr := maybePostRunAuthUpload(client, logger, authPath, beforeHash, beforeRefresh)
	if postAuthErr != nil {
		exitCode, runErr = mergeLifecycleFailure(exitCode, runErr, postAuthErr)
	}

	// Exit footer.
	if !opts.SkipBoot {
		caps := footerCaps(ui.DetectCaps(themeFromConfig(cfg)), opts.Minimal)
		fmt.Fprintln(os.Stderr)
		footerExit := exitCode
		if runErr != nil && footerExit == 0 {
			footerExit = 1
		}
		ui.PrintExitFooter(os.Stderr, caps, "cdx", ui.ExitFooter{
			RunDuration:   duration,
			ExitCode:      footerExit,
			AuthStatus:    authStatus,
			AuthTone:      authTone,
			EngineName:    "codex",
			EngineVersion: codex.Version(ctx),
		})
	}

	return exitCode, runErr
}

func mergeLifecycleFailure(exitCode int, current, next error) (int, error) {
	if next == nil {
		return exitCode, current
	}
	if exitCode == 0 {
		exitCode = 1
	}
	return exitCode, errors.Join(current, next)
}

func launchArgsForAuth(args []string, auth *orchestrator.AuthRetrieveResponse) []string {
	if auth == nil || auth.Host == nil || strings.EqualFold(strings.TrimSpace(auth.Status), "offline") || strings.EqualFold(strings.TrimSpace(auth.Status), "error") {
		return args
	}
	preference := strings.ToLower(strings.TrimSpace(auth.Host.LanePreference))
	if codex.LaneModel(preference) == "" {
		return args
	}
	return codex.ApplyLanePreference(args, preference)
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

// bootstrap tries SyncBootstrap first and, on 404/501, falls back to the
// per-resource pulls. Returns the same tuple regardless of which path ran.
// The last value carries the fleet activity counters when the bundle path was
// taken (nil on the legacy path or when the server didn't supply them).
func bootstrap(
	ctx context.Context, client *orchestrator.Client, logger *slog.Logger,
	concurrent bool, authPath string,
) (*orchestrator.AuthRetrieveResponse, error, bool, summary.ResourceSync, summary.ResourceSync, *orchestrator.FleetSessions) {
	var (
		candidate   []byte
		expected    codex.AuthGeneration
		uploadLease *codex.AuthUploadLease
	)
	localUsable := false
	if lease, readErr := codex.BeginAuthUpload(false); readErr == nil {
		uploadLease = lease
		localUsable = codex.IsValidLocalAuth(authPath)
		// An unusable local file must not advertise its sidecar's canonical
		// digest: doing so returns `valid` without an auth payload and leaves a
		// concurrent run blocked. Retain its generation for CAS, but omit both
		// digest and candidate so the server returns verified canonical auth.
		if localUsable && json.Valid(lease.Payload()) {
			candidate = lease.Payload()
		}
		expected = lease.Generation()
	} else if errors.Is(readErr, codex.ErrLogoutIntentActive) {
		expected, readErr = codex.CurrentAuthGeneration()
		if readErr != nil {
			return &orchestrator.AuthRetrieveResponse{Status: "error", Message: readErr.Error()},
				fmt.Errorf("snapshot logged-out auth generation: %w", readErr), false, summary.ResourceSync{}, summary.ResourceSync{}, nil
		}
	} else if errors.Is(readErr, os.ErrNotExist) {
		expected, readErr = codex.CurrentAuthGeneration()
		if readErr != nil {
			return &orchestrator.AuthRetrieveResponse{Status: "error", Message: readErr.Error()},
				fmt.Errorf("snapshot missing auth generation: %w", readErr), false, summary.ResourceSync{}, summary.ResourceSync{}, nil
		}
	} else {
		return &orchestrator.AuthRetrieveResponse{Status: "error", Message: readErr.Error()},
			fmt.Errorf("stabilize local auth candidate: %w", readErr), false, summary.ResourceSync{}, summary.ResourceSync{}, nil
	}
	if uploadLease != nil {
		defer func() {
			_ = uploadLease.Close()
		}()
	}
	digest := ""
	if localUsable {
		digest = expected.Digest
	}

	agentsFile, agentsPathErr := agentsPath()
	if agentsPathErr != nil {
		logger.Warn("resolving agents path failed; skipping agents sync", "err", agentsPathErr)
	}
	configFile, configPathErr := configTomlPath()
	if configPathErr != nil {
		logger.Warn("resolving config path failed; skipping config sync", "err", configPathErr)
	}

	agentsDigest := fileDigest(agentsFile)
	configDigest := fileDigest(configFile)

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
	if uploadLease != nil {
		if berr == nil && uploadLease.IntentGeneration().Exists && bundleAcceptedAuthCandidate(resp) {
			acknowledged, ackErr := uploadLease.AcknowledgeObservedLogout()
			if ackErr != nil {
				berr = fmt.Errorf("acknowledge bootstrap-accepted login over logout: %w", ackErr)
			} else if !acknowledged {
				berr = errors.New("auth or logout intent changed while bootstrap candidate was in flight")
			}
		}
		releaseErr := uploadLease.Close()
		uploadLease = nil
		if releaseErr != nil {
			berr = errors.Join(berr, fmt.Errorf("release bootstrap auth upload transaction: %w", releaseErr))
		}
	}

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
			return &orchestrator.AuthRetrieveResponse{Status: st}, nil, false, summary.ResourceSync{}, summary.ResourceSync{}, nil
		}
		// Treat network/server failure as "offline" for Decide().
		offline := &orchestrator.AuthRetrieveResponse{Status: "offline", Message: berr.Error()}
		return offline, berr, false, summary.ResourceSync{}, summary.ResourceSync{}, nil
	}

	// Apply bundle outputs.
	authResp := resp.Auth
	if authResp == nil {
		authResp = &orchestrator.AuthRetrieveResponse{Status: "offline", Message: "bundle missing auth block"}
	}
	if err := updateAuthSessionSecurity(authResp); err != nil {
		return authResp, fmt.Errorf("update auth session security state: %w", err), false, summary.ResourceSync{}, summary.ResourceSync{}, resp.Sessions
	}
	authSynced, keptFresherLocal, applyErr := applyServerAuth(logger, authPath, authResp, concurrent, expected)
	var convergenceErr error
	if keptFresherLocal && !concurrent {
		// The fleet canonical is behind this host's credential (typically a
		// fresh `codex login` the server-side store gated — runner outage or
		// an old server). Push it explicitly so the fleet converges as soon
		// as the store accepts again; never block launch on the outcome.
		if raw, rerr := codex.ReadAuth(); rerr == nil && len(raw) > 0 {
			if perr := pushAuthCandidate(ctx, client, logger, false); perr != nil {
				logger.Warn("fresher local auth upload rejected", "err", perr)
				fmt.Fprintln(os.Stderr, ui.PlainInline("cdx: orchestrator did not accept the newer local credentials: "+perr.Error()))
				if orchestrator.IsUnsafeRunnerUpdatedAuthError(perr) {
					convergenceErr = perr
				}
			} else {
				fmt.Fprintln(os.Stderr, "cdx: newer local credentials uploaded to the orchestrator")
			}
		}
	}

	agentsSync := summary.ResourceSync{}
	configSync := summary.ResourceSync{}
	if !concurrent {
		agentsSync.Checked = true
		agentsSync.Err = agentsPathErr
		if agentsSync.Err == nil && len(resp.Agents) > 0 {
			if err := atomicWrite(agentsFile, resp.Agents, 0o644); err != nil {
				logger.Debug("bundle agents write failed", "err", err)
				agentsSync.Err = err
			} else {
				agentsSync.Updated = true
			}
		}
		configSync.Checked = true
		configSync.Err = configPathErr
		if configSync.Err == nil && len(resp.Config) > 0 {
			if err := atomicWrite(configFile, resp.Config, 0o644); err != nil {
				logger.Debug("bundle config write failed", "err", err)
				configSync.Err = err
			} else {
				configSync.Updated = true
			}
		}
	}
	if applyErr != nil {
		applyErr = &authMaterializationError{err: applyErr}
	}
	return authResp, errors.Join(applyErr, convergenceErr), authSynced, agentsSync, configSync, resp.Sessions
}

func bundleAcceptedAuthCandidate(resp *orchestrator.BundleResponse) bool {
	if resp == nil || resp.Auth == nil || !resp.Auth.AuthCandidateAccepted() {
		return false
	}
	for _, reason := range resp.Reasons {
		if strings.EqualFold(strings.TrimSpace(reason), "auth_stored") {
			return true
		}
	}
	switch strings.ToLower(strings.TrimSpace(resp.Auth.Status)) {
	case "valid", "updated":
		return true
	default:
		return false
	}
}

// legacySyncPath runs the per-resource sync (auth + agents + config) when the
// server is too old for /sync/bootstrap.
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
			conf.Updated, conf.Err = writeConfigToml(syncCtx, client)
			if conf.Err != nil {
				logger.Debug("config sync skipped", "err", conf.Err)
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
// store-side error if it rejects.) The store endpoint REQUIRES last_refresh;
// vanilla `codex login` files carry none, so backfill it in-memory the same
// way `cdx auth-upload` does — without this the post-login recovery upload
// always bounced on the server's RFC3339 validation.
func pushAuthCandidate(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, acknowledgeLogout bool) error {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, expected, err := storeCurrentAuthCandidate(cctx, client, acknowledgeLogout)
	if err != nil {
		return err
	}
	if resp != nil && len(resp.Auth) > 0 {
		authPath, _ := codex.AuthPath()
		if _, _, err := applyServerAuth(logger, authPath, resp, false, expected); err != nil {
			return fmt.Errorf("materialize accepted auth: %w", err)
		}
	}
	return nil
}

// storeCurrentAuthCandidate snapshots one exact auth + logout-marker
// generation, stores it, then acknowledges that old marker only after the
// server accepts the request. The returned generation is the CAS base for any
// authoritative writeback.
func storeCurrentAuthCandidate(ctx context.Context, client *orchestrator.Client, acknowledgeLogout bool) (*orchestrator.AuthRetrieveResponse, codex.AuthGeneration, error) {
	upload, err := codex.BeginAuthUpload(acknowledgeLogout)
	if err != nil {
		return nil, codex.AuthGeneration{}, err
	}
	expected := upload.Generation()
	resp, err := client.AuthStore(ctx, upload.Payload())
	if err != nil {
		_ = upload.Close()
		return resp, expected, err
	}
	if !resp.AuthCandidateAccepted() {
		closeErr := upload.Close()
		securityErr := updateAuthSessionSecurity(resp)
		status := ""
		if resp != nil {
			status = resp.Status
		}
		return resp, expected, errors.Join(
			fmt.Errorf("server did not accept the uploaded Codex credential generation (status %q)", status),
			closeErr,
			securityErr,
		)
	}
	if upload.IntentGeneration().Exists {
		if acknowledged, err := upload.AcknowledgeObservedLogout(); err != nil {
			_ = upload.Close()
			return resp, expected, fmt.Errorf("clear accepted auth's prior logout intent: %w", err)
		} else if !acknowledged {
			_ = upload.Close()
			return resp, expected, errors.New("auth or logout intent changed while accepted store was in flight")
		}
	}
	if err := upload.Close(); err != nil {
		return resp, expected, fmt.Errorf("release accepted auth upload transaction: %w", err)
	}
	if err := updateAuthSessionSecurity(resp); err != nil {
		return resp, expected, fmt.Errorf("update auth session security state: %w", err)
	}
	return resp, expected, nil
}

// needsInteractiveAuthRecovery reports whether the launch gate has reached a
// dead end that only a fresh `codex login` can resolve: a server-confirmed live
// verification failure, or a missing/upload-required state where the local file
// is unusable or the server rejected it.
// authRecoveryAction is the verdict for how a run responds when the auth
// decision says credentials need re-minting.
type authRecoveryAction int

const (
	authRecoverySkip        authRecoveryAction = iota // nothing to do
	authRecoveryInteractive                           // offer `codex login`
	authRecoveryFailClosed                            // headless: refuse, no prompt
)

// decideAuthRecovery encodes the launch-gate rule: a concurrent sync-paused run
// never recovers; a non-interactive run (cron, --execute → headless) fails
// closed rather than opening a login prompt; an interactive run offers
// `codex login`. Kept pure so the policy is unit-testable without the full
// network/exec lifecycle.
func decideAuthRecovery(concurrent, headless, recoveryNeeded bool) authRecoveryAction {
	if concurrent || !recoveryNeeded {
		return authRecoverySkip
	}
	if headless {
		return authRecoveryFailClosed
	}
	return authRecoveryInteractive
}

func needsInteractiveAuthRecovery(dec orchestrator.AuthDecision, uploadErr error, hostSecure bool) bool {
	if orchestrator.IsUnsafeRunnerUpdatedAuthError(uploadErr) {
		return false
	}
	if dec.VerificationFailed {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(dec.Status)) {
	case "missing", "upload_required":
		if uploadErr != nil {
			// Only a definitive server-side rejection (4xx) means the local
			// credentials are actually bad and a re-login can fix things. An
			// infrastructure failure (runner outage 503, transport error)
			// would reject the freshly-minted token exactly the same way —
			// prompting a login loop that cannot succeed. Launch with the
			// local file instead; the next run re-attempts the upload.
			return authUploadRejected(uploadErr)
		}
		return !localAuthRunnableFresh(hostSecure)
	}
	return false
}

// authUploadRejected reports whether the /auth store error is a definitive
// 4xx rejection of the credentials (as opposed to a gated/unavailable store).
func authUploadRejected(err error) bool {
	return orchestrator.IsDefinitiveAuthCandidateRejection(err)
}

// recoveryReason renders the human-facing line shown before the login prompt.
func recoveryReason(dec orchestrator.AuthDecision, uploadErr error) string {
	if uploadErr != nil {
		return "Local Codex credentials were not accepted by the server: " + uploadErr.Error()
	}
	if dec.Reason != "" {
		return dec.Reason
	}
	return "Codex credentials are missing from the orchestrator."
}

// localAuthRunnableFresh reports whether native Codex can either use the
// selected credential directly or refresh it, within the same bounded cache
// window used by the launch decision.
func localAuthRunnableFresh(hostSecure bool) bool {
	path, err := codex.AuthPath()
	if err != nil || path == "" {
		return false
	}
	if fresh, _ := codex.IsFresh(path, codex.MaxAge24h); fresh {
		return true
	}
	if hostSecure {
		fresh, _ := codex.IsFresh(path, codex.MaxAge7d)
		return fresh
	}
	return false
}

// recoverCodexAuth runs the interactive `codex login` flow, uploads the freshly
// minted credentials to the canonical store, and reports success only once the
// server has accepted them. Refuses outside an interactive terminal so cron and
// --execute fail closed rather than hanging on a prompt.
func recoverCodexAuth(ctx context.Context, cfg *config.Config, client *orchestrator.Client, reason string) error {
	if !term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stdout.Fd())) || !term.IsTerminal(int(os.Stderr.Fd())) {
		return errAuthRecoveryNonInteractive
	}
	fmt.Fprintln(os.Stderr)
	if strings.TrimSpace(reason) != "" {
		fmt.Fprintln(os.Stderr, "cdx: "+reason)
	}
	fmt.Fprint(os.Stderr, "cdx: Run `codex login`, upload credentials, and verify with the server now? [y/N] ")
	answer, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return fmt.Errorf("read auth recovery answer: %w", err)
	}
	answer = strings.ToLower(strings.TrimSpace(answer))
	if answer != "y" && answer != "yes" {
		return errAuthRecoveryDeclined
	}

	exit, err := codex.Run(ctx, cfg, []string{"login"})
	if err != nil {
		return fmt.Errorf("codex login: %w", err)
	}
	if exit != 0 {
		return fmt.Errorf("codex login exited with status %d", exit)
	}
	raw, err := codex.ReadAuth()
	if err != nil {
		return fmt.Errorf("read Codex credentials after login: %w", err)
	}
	if len(raw) == 0 {
		return fmt.Errorf("no Codex credentials found after login")
	}
	if err := pushAuthCandidate(ctx, client, slog.Default(), true); err != nil {
		return fmt.Errorf("upload Codex credentials after login: %w", err)
	}
	fmt.Fprintln(os.Stderr, "cdx: Codex credentials uploaded and accepted by the server.")
	return nil
}

func applyQuotaHardFailOverride(state *ui.ScreenInput) string {
	if state == nil {
		return ""
	}
	quotaMessage := state.QuotaBlock
	state.QuotaBlock = ""
	state.QuotaWarn = quotaMessage + "; hard-fail overridden by QUOTA_HARD_FAIL=0"
	state.ResultLabel = "Quota limit overridden; launching with QUOTA_HARD_FAIL=0."
	state.ResultTone = ui.ToneWarn
	return quotaMessage
}

func syncAuthLegacy(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, concurrent bool) (*orchestrator.AuthRetrieveResponse, error, bool) {
	localUsable := false
	_, expected, err := codex.ReadAuthForUpload()
	if err != nil {
		expected, err = codex.CurrentAuthGeneration()
		if err != nil {
			return nil, fmt.Errorf("local digest: %w", err), false
		}
	} else if authPath, pathErr := codex.AuthPath(); pathErr == nil {
		localUsable = codex.IsValidLocalAuth(authPath)
	}
	digest := ""
	if localUsable {
		digest = expected.Digest
	}
	resp, err := client.AuthRetrieve(ctx, digest)
	if err != nil {
		return &orchestrator.AuthRetrieveResponse{Status: "offline", Message: err.Error()}, err, false
	}
	if err := updateAuthSessionSecurity(resp); err != nil {
		return resp, fmt.Errorf("update auth session security state: %w", err), false
	}
	switch strings.ToLower(resp.Status) {
	case "current", "ok", "valid", "unchanged", "":
		return resp, nil, false
	case "outdated", "updated", "missing":
		authPath, _ := codex.AuthPath()
		wrote, keptFresher, writeErr := applyServerAuth(logger, authPath, resp, concurrent, expected)
		if writeErr != nil {
			return resp, &authMaterializationError{err: writeErr}, wrote
		}
		if !keptFresher || concurrent {
			return resp, nil, wrote
		}

		// A legacy server retrieves before it sees the local candidate. Try the
		// two-way convergence explicitly. Accepted stores converge to the new
		// credential; transient/security/rate failures retain it. Only a
		// validation-shaped rejection authorizes the already-retrieved, verified
		// canonical fallback to replace that exact rejected generation.
		storeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		storeResp, storeExpected, storeErr := storeCurrentAuthCandidate(storeCtx, client, false)
		if storeErr == nil {
			if storeResp != nil && len(storeResp.Auth) > 0 {
				stored, _, applyErr := applyServerAuth(logger, authPath, storeResp, false, storeExpected)
				if applyErr != nil {
					return storeResp, &authMaterializationError{err: applyErr}, stored
				}
				return storeResp, nil, stored
			}
			return storeResp, nil, false
		}
		if orchestrator.IsDefinitiveAuthCandidateRejection(storeErr) &&
			strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified") {
			fallback := *resp
			fallback.CandidateRejectedDefinitive = true
			healed, _, applyErr := applyServerAuth(logger, authPath, &fallback, false, storeExpected)
			if applyErr != nil {
				return resp, &authMaterializationError{err: applyErr}, healed
			}
			return resp, nil, healed
		}
		if orchestrator.IsUnsafeRunnerUpdatedAuthError(storeErr) {
			return resp, storeErr, false
		}
		logger.Warn("legacy auth candidate store did not converge; preserving newer local auth", "err", storeErr)
		return resp, nil, wrote
	default:
		// Unknown / refused / insecure — return the response as-is and let
		// Decide() classify; do not synthesise an error here.
		return resp, nil, false
	}
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

// applyServerAuth decides whether the server's canonical payload may replace
// ~/.codex/auth.json and writes it when allowed. Two refusal gates in front of
// the legacy status check:
//
//  1. verification_state must be exactly verified — unknown, pending, failed,
//     or omitted server credentials are never materialized.
//  2. the local file is FRESHER than the payload — a login the orchestrator
//     has not adopted yet (runner outage gating the store, old server, …).
//     Overwriting would destroy the only copy of the newer credential; this
//     is exactly the `codex login` → relaunch → clobbered-by-stale-canonical
//     failure.
//
// Returns (wrote, keptFresherLocal, error).
func applyServerAuth(logger *slog.Logger, authPath string, resp *orchestrator.AuthRetrieveResponse, concurrent bool, expected codex.AuthGeneration) (bool, bool, error) {
	if resp == nil || !shouldWriteServerAuth(resp.Status, resp.Auth) {
		return false, false, nil
	}
	if !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified") {
		logger.Warn("server canonical auth is not runner-verified; keeping local auth.json",
			"verification_state", resp.VerificationState)
		return false, authPath != "" && codex.IsValidLocalAuth(authPath), nil
	}
	logoutHold, err := codex.LogoutIntentActive()
	if err != nil || logoutHold {
		logger.Warn("explicit local logout prevents canonical auth restore", "err", err)
		return false, false, nil
	}
	definitiveFallback := resp.CandidateRejectedDefinitive && strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified")
	if localAuthFresherThan(authPath, resp.Auth) && !definitiveFallback {
		logger.Warn("local auth.json is newer than server canonical; refusing to overwrite",
			"canonical_last_refresh", resp.CanonicalLastRefresh)
		fmt.Fprintln(os.Stderr, "cdx: local auth.json is newer than the fleet canonical; keeping the local copy")
		return false, true, nil
	}
	result, err := codex.ConvergeAuthIfCurrent(resp.Auth, expected)
	if err != nil {
		logger.Warn("auth write from server failed", "err", err)
		return false, false, err
	}
	if !result.Written {
		if result.AlreadyCurrent {
			return false, false, nil
		}
		if result.KeptNewerGeneration {
			logger.Warn("local auth.json changed while server request was in flight; keeping newer generation")
			return false, true, nil
		}
		if result.Current != expected && !codex.IsValidLocalAuth(authPath) {
			return false, false, errors.New("canonical auth was required but a changed unusable local generation prevented materialization")
		}
		if result.BlockedByActiveChild {
			return false, false, errors.New("canonical auth was required but the unchanged local generation is still owned by a native Codex child")
		}
		return false, false, errors.New("canonical auth was required but could not be materialized")
	}
	logger.Debug("auth.json updated from orchestrator", "concurrent", concurrent, "status", resp.Status)
	return true, false, nil
}

// localAuthFresherThan reports whether the on-disk auth.json is strictly newer
// than the server payload. Freshness of the local file is its last_refresh
// stamp, falling back to file mtime for vanilla `codex login` files that carry
// none. A server payload without a parseable last_refresh never wins over an
// existing local file.
func localAuthFresherThan(localPath string, serverAuth []byte) bool {
	if localPath == "" || !codex.IsValidLocalAuth(localPath) {
		return false
	}
	localT, err := codex.LastRefreshOfFile(localPath)
	if err != nil {
		return false
	}
	serverT, err := codex.LastRefreshFromRaw(serverAuth)
	if err != nil {
		return true
	}
	return localT.After(serverT)
}

func writeAgents(ctx context.Context, client *orchestrator.Client) (bool, error) {
	dst, err := agentsPath()
	if err != nil {
		return false, err
	}
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

func writeConfigToml(ctx context.Context, client *orchestrator.Client) (bool, error) {
	dst, err := configTomlPath()
	if err != nil {
		return false, err
	}
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

func agentsPath() (string, error) {
	home, err := codex.CodexHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "AGENTS.md"), nil
}

func configTomlPath() (string, error) {
	home, err := codex.CodexHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "config.toml"), nil
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
func maybePostRunAuthUpload(client *orchestrator.Client, logger *slog.Logger, path, beforeHash, beforeRefresh string) (string, ui.Tone, error) {
	if path == "" {
		return "not checked", ui.ToneDim, nil
	}
	afterHash, afterRefresh := snapshotAuth(path)
	if afterHash == "" {
		if beforeHash != "" {
			current, err := codex.CurrentAuthGeneration()
			if err != nil {
				logger.Warn("post-run logout snapshot failed", "err", err)
				return "logout marker failed", ui.ToneFail, fmt.Errorf("snapshot logout state: %w", err)
			}
			if marked, markErr := codex.MarkLogoutIntent(current); markErr != nil {
				logger.Warn("post-run logout intent write failed", "err", markErr)
				return "logout marker failed", ui.ToneFail, fmt.Errorf("record logout intent: %w", markErr)
			} else if marked {
				return "logged out", ui.ToneWarn, nil
			}
			return "newer local kept", ui.ToneOK, nil
		}
		return "not found", ui.ToneWarn, nil
	}
	if afterHash == beforeHash && afterRefresh == beforeRefresh {
		return "unchanged", ui.ToneOK, nil
	}
	upload, err := codex.BeginAuthUpload(false)
	if err != nil {
		if errors.Is(err, codex.ErrLogoutIntentActive) {
			return "logged out", ui.ToneWarn, nil
		}
		logger.Warn("post-run auth read failed", "err", err)
		return "read failed", ui.ToneFail, fmt.Errorf("read changed local auth: %w", err)
	}
	expected := upload.Generation()
	expectedIntent := upload.IntentGeneration()
	// 15s budget: a login during the session is the one credential mint the
	// fleet must not lose — give the upload room and make failure visible. The
	// auth lock deliberately stays held across this bounded request so explicit
	// logout orders wholly before or after the store boundary.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	resp, err := client.AuthStore(ctx, upload.Payload())
	cancel()
	if err == nil && !resp.AuthCandidateAccepted() {
		status := ""
		if resp != nil {
			status = resp.Status
		}
		err = fmt.Errorf("server did not accept the uploaded Codex credential generation (status %q)", status)
	}
	if err == nil && expectedIntent.Exists {
		acknowledged, ackErr := upload.AcknowledgeObservedLogout()
		if ackErr != nil {
			err = fmt.Errorf("acknowledge accepted changed login over logout: %w", ackErr)
		} else if !acknowledged {
			err = errors.New("auth or logout intent changed while post-run store was in flight")
		} else {
			expectedIntent = codex.LogoutIntentGeneration{}
		}
	}
	releaseErr := upload.Close()
	securityErr := updateAuthSessionSecurity(resp)
	if err != nil {
		logger.Warn("post-run auth upload failed", "err", err)
		return "upload failed", ui.ToneFail, errors.Join(fmt.Errorf("upload changed local auth: %w", err), releaseErr, securityErr)
	}
	if releaseErr != nil {
		return "upload cleanup failed", ui.ToneFail, fmt.Errorf("release post-run auth upload transaction: %w", releaseErr)
	}
	if securityErr != nil {
		return "security update failed", ui.ToneFail, fmt.Errorf("update auth session security state: %w", securityErr)
	}
	latestIntent, intentErr := codex.CurrentLogoutIntentGeneration()
	if intentErr != nil {
		return "logout check failed", ui.ToneFail, fmt.Errorf("inspect logout intent after upload: %w", intentErr)
	}
	if latestIntent != expectedIntent {
		logger.Debug("post-run store completed before overlapping explicit logout; skipping local writeback")
		return "logged out", ui.ToneWarn, nil
	}
	keptNewer := false
	if resp != nil && len(resp.Auth) > 0 {
		_, kept, err := applyServerAuth(logger, path, resp, false, expected)
		if err != nil {
			logger.Warn("post-run accepted auth writeback failed", "err", err)
			return "writeback failed", ui.ToneFail, fmt.Errorf("write accepted auth response: %w", err)
		}
		keptNewer = kept
	}
	logger.Debug("post-run auth uploaded", "hash_changed", beforeHash != afterHash, "refresh_changed", beforeRefresh != afterRefresh)
	if keptNewer {
		return "uploaded; newer local kept", ui.ToneOK, nil
	}
	return "uploaded", ui.ToneOK, nil
}

func markOfflineHealth(dots []ui.HealthDot) {
	for i := range dots {
		if dots[i].Name == "api" || dots[i].Name == "auth" {
			dots[i].Tone = ui.ToneWarn
		}
	}
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

func updateCaps(cfg *config.Config, minimal bool) ui.Caps {
	caps := ui.DetectCaps(themeFromConfig(cfg))
	if minimal {
		return ui.MinimalCaps(caps)
	}
	return caps
}

// maybeEnsureCodex repairs the local Codex CLI when the orchestrator says
// auto-update is enabled, a target version is known, and the local CLI
// version differs from that target. Failures are logged but never fatal —
// a transient install error just leaves the current version in place for
// next time.
//
// Called after the Codex session has already exited (see Run), so the
// install never delays an interactive launch; the user only pays for it
// once, on their way out, and the new version takes effect on the next run.
//
// Returns the post-install version when an install actually ran successfully,
// empty string otherwise (no-op cases + failures). The lifecycle independently
// re-measures the installed version for the exit footer.
//
// This is a no-op when concurrent managed sync is paused, when auth retrieval
// failed, or when AutoUpdateEnabled is false.
func maybeEnsureCodex(ctx context.Context, cfg *config.Config, auth *orchestrator.AuthRetrieveResponse, concurrent, minimal bool, logger *slog.Logger) string {
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
	// Defer "latest" (and empty) alias upgrades to cron — must be before the semver guards.
	if target == "" || target == "latest" {
		return ""
	}
	if current == target {
		return ""
	}
	if !v.ClientVersionEnforceExact {
		if current != "" && current != "unknown" && !semverGT(target, current) {
			logger.Warn("skipping downgrade", "current", current, "target", target)
			return ""
		}
	}
	// EnsureCodex is a 5-10s blocking operation when an install actually
	// downloads from GitHub. Surface a single human-readable progress line
	// on stderr so the user knows what's happening — the structured-log
	// emissions inside the installer are at Debug now.
	caps := updateCaps(cfg, minimal)
	fmt.Fprintln(os.Stderr, ui.UpdateProgress(caps, "cdx", "codex", current, target))
	if err := codex.EnsureCodex(ctx, target, v.ClientVersionEnforceExact, logger); err != nil {
		logger.Warn("codex auto-update skipped", "err", err, "target", target, "current", current)
		fmt.Fprintln(os.Stderr, ui.UpdateFailure(caps, "cdx", "codex", target, err))
		return ""
	}
	post := strings.TrimSpace(codex.Version(ctx))
	if post == "" || post == "unknown" {
		post = target
	}
	fmt.Fprintln(os.Stderr, ui.UpdateComplete(caps, "cdx", "codex", post, false))
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
	if os.Getenv("CODEX_WRAPPER_RESTARTED") == "1" {
		logger.Warn("wrapper auto-update skipped after restart", "current", current, "target", target)
		return
	}
	if v.WrapperURL == nil || *v.WrapperURL == "" || v.WrapperSHA256 == nil || *v.WrapperSHA256 == "" {
		logger.Warn("wrapper auto-update skipped: missing artifact metadata", "current", current, "target", target)
		return
	}
	caps := updateCaps(cfg, minimal)
	fmt.Fprintln(os.Stderr, ui.UpdateProgress(caps, "cdx", "wrapper", current, target))
	exe, err := update.SelfUpdateFrom(ctx, cfg, *v.WrapperURL, *v.WrapperSHA256, target, logger)
	if err != nil {
		logger.Warn("wrapper auto-update skipped", "err", err, "target", target, "current", current)
		fmt.Fprintln(os.Stderr, ui.UpdateFailure(caps, "cdx", "wrapper", target, err))
		return
	}
	fmt.Fprintln(os.Stderr, ui.UpdateComplete(caps, "cdx", "wrapper", target, true))
	if err := update.ReExecAfterUpdate(exe, update.SnapshottedArgv); err != nil {
		logger.Warn("wrapper restart after update failed", "err", err)
		fmt.Fprintln(os.Stderr, ui.UpdateFailure(caps, "cdx", "wrapper", target, err))
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

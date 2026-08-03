// cdx — Codex Orchestrator wrapper, engine=codex.
//
// Subcommands: run (default), resume, status, doctor, lane, profile, exec,
// auth-upload, --version, --update, --cron [install|remove|run], --uninstall,
// --execute, --resume.
package codexapp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	hostcron "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/log"
	enginecron "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/ui"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/uninstall"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/update"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

// maxRestartDepth caps how many times the wrapper may re-exec itself after a
// self-update before it bails out. Each self-update increments
// CODEX_WRAPPER_RESTART_DEPTH; >2 means the new binary is also asking for
// another update, which is almost certainly a feedback loop.
const maxRestartDepth = 2

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

// Run executes the Codex-compatible wrapper persona. The multicall dispatcher
// passes argv without the program name so alias and explicit cxx dispatch are
// behaviorally identical.
func Run(args []string, stdout, stderr io.Writer) int {
	return run(args, stdout, stderr)
}

// Parsed flags shared across subcommands.
type flags struct {
	configPath     string
	silent         bool
	debug          bool
	minimal        bool
	skipBoot       bool
	versionFlag    bool
	updateFlag     bool
	uninstallFlag  bool
	statusFlag     bool
	doctorFlag     bool
	wrapperHelp    bool
	cronArgs       []string
	executePrompt  string
	executeInvalid bool
	// resumeFlag records that --resume was given at all; resumeSession holds
	// its optional value. The two are distinct because a bare --resume is a
	// valid request for the upstream session picker, which resumeSession ==
	// "" cannot express on its own.
	resumeFlag      bool
	resumeSession   string
	forceIPv4       bool
	allowConc       bool
	helpPassthrough bool
}

// wrapperOwnedSubcommands are subcommand tokens owned by the wrapper itself —
// these must never be re-routed as profile shorthand even if a matching
// [profiles.NAME] section exists in config.toml.
var wrapperOwnedSubcommands = map[string]bool{
	"run":         true,
	"status":      true,
	"doctor":      true,
	"auth-upload": true,
	"lane":        true,
	"profile":     true,
	"update":      true,
	"uninstall":   true,
	"cron":        true,
	"execute":     true,
	"ls":          true,
	"resume":      true,
}

// resumeArgs builds the upstream argv for a resume request. Codex spells resume
// as a subcommand (`codex resume [SESSION_ID] [PROMPT]`), so the token leads and
// any session id / trailing prompt follows positionally. Both `cdx resume ...`
// and `cdx --resume <id> ...` funnel through here, which is what keeps the two
// spellings from drifting apart again.
func resumeArgs(rest, passthrough []string) []string {
	out := append([]string{"resume"}, rest...)
	return append(out, passthrough...)
}

// isProfileShorthand reports whether `sub` is a candidate for the legacy
// `cdx <profile-name>` shorthand: not empty, not a wrapper-owned subcommand,
// and not one of the reserved Codex subcommand names. The caller still has
// to confirm the profile actually exists in config.toml.
func isProfileShorthand(sub string) bool {
	if sub == "" {
		return false
	}
	if wrapperOwnedSubcommands[sub] {
		return false
	}
	if reservedCodexSubcommands[sub] {
		return false
	}
	return true
}

// reservedCodexSubcommands lists the Codex subcommands the wrapper must never
// interpret as profile shorthand and whose `--help` invocations are passed
// straight through to the upstream codex CLI.
var reservedCodexSubcommands = map[string]bool{
	"exec":       true,
	"review":     true,
	"login":      true,
	"logout":     true,
	"mcp":        true,
	"mcp-server": true,
	"app-server": true,
	"completion": true,
	"sandbox":    true,
	"debug":      true,
	"apply":      true,
	"resume":     true,
	"fork":       true,
	"cloud":      true,
	"features":   true,
	"help":       true,
}

// isHelpPassthrough returns true when argv requests upstream Codex help text.
// Matched forms (per legacy fe70ac3:docs/interface-cdx.md):
//   - top-level `--help` / `-h` appearing before any positional token
//   - bare `help` as the first positional token
//   - `<reserved-subcommand> ... --help` / `<reserved-subcommand> ... -h`
//
// The wrapper must not perform any side effects (lock, sync, boot screen) in
// these cases — argv is execed straight into the real codex binary.
func isHelpPassthrough(args []string) bool {
	if len(args) == 0 {
		return false
	}
	firstPositional := ""
	helpBeforePositional := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			break
		}
		if a == "--help" || a == "-h" {
			if firstPositional == "" {
				helpBeforePositional = true
			}
			continue
		}
		// Flags that consume the following token as a value (mirrors
		// parseFlags below) must not let that value be mistaken for the
		// first positional argument.
		switch a {
		case "--resume", "--execute", "--config":
			if i+1 < len(args) {
				i++
			}
			continue
		case "--cron":
			if i+1 < len(args) {
				next := args[i+1]
				if next == "install" || next == "remove" || next == "run" {
					i++
				}
			}
			continue
		}
		if strings.HasPrefix(a, "-") {
			continue
		}
		if firstPositional == "" {
			firstPositional = a
		}
	}
	// `cdx help` is itself a Codex-recognised help token.
	if firstPositional == "help" {
		return true
	}
	// Top-level `--help` / `-h` with no positional before it.
	if helpBeforePositional {
		return true
	}
	// Reserved-subcommand help (e.g. `cdx exec --help`).
	if firstPositional != "" && reservedCodexSubcommands[firstPositional] {
		for _, a := range args {
			if a == "--" {
				break
			}
			if a == "--help" || a == "-h" {
				return true
			}
		}
	}
	return false
}

// helpExecArgv removes wrapper-only presentation flags before handing a help
// request to the upstream CLI. Tokens after `--` belong to Codex and are left
// untouched.
func helpExecArgv(args []string) []string {
	out := make([]string, 0, len(args))
	for i, arg := range args {
		if arg == "--" {
			out = append(out, args[i:]...)
			break
		}
		if arg == "--minimal" || arg == "--minimal-output" {
			continue
		}
		out = append(out, arg)
	}
	return out
}

func run(args []string, stdout, stderr io.Writer) (exitCode int) {
	// A self-update exec hands its durable purge IDs and one inherited shared
	// lease to the new wrapper. Adopt that handoff before even the restart-depth
	// or config checks so every exit path services an insecure purge request.
	handoffSession, handoffErr := codex.ResumeAuthSessionReexecHandoff()
	if handoffErr != nil {
		fmt.Fprintln(stderr, "cdx: resume auth session after update:", handoffErr)
		return 1
	}
	if handoffSession != nil {
		defer func() {
			removed, _, finishErr := codex.FinishAuthSession(handoffSession)
			if finishErr != nil {
				fmt.Fprintln(stderr, "cdx: auth session cleanup after update:", finishErr)
				exitCode = 1
			} else if removed {
				fmt.Fprintln(stderr, "cdx: insecure-host credentials purged")
			}
		}()
	}

	// Restart-loop guard: each successful self-update increments
	// CODEX_WRAPPER_RESTART_DEPTH and re-execs us. Cap that at maxRestartDepth
	// so a misbehaving server (or a corrupt local binary that keeps reporting
	// itself out-of-date) cannot fork-bomb our way out of the host.
	depth, _ := strconv.Atoi(os.Getenv("CODEX_WRAPPER_RESTART_DEPTH"))
	if depth > maxRestartDepth {
		fmt.Fprintf(stderr, "cdx: restart depth %d exceeded cap %d - refusing to continue\n", depth, maxRestartDepth)
		return 70
	}

	// Snapshot argv before any flag parsing so the update path can re-exec
	// the freshly installed binary with the exact same command the operator
	// originally typed.
	snap := make([]string, len(args))
	copy(snap, args)
	update.SnapshottedArgv = snap

	// Propagate the build-time wrapper version into the cron package so its
	// /cron/check + /cron/report payloads carry the right wrapper_version.
	enginecron.WrapperVersion = Version

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	f, positional, passthrough := parseFlags(args)
	if actions := conflictingActions(f, positional); len(actions) > 1 {
		fmt.Fprintln(stderr, "cdx: conflicting wrapper actions:", strings.Join(actions, ", "))
		return 2
	}

	if f.wrapperHelp {
		ui.PrintWrapperHelp(stdout, commandCaps(ui.DetectCapsFor(stdout, ""), f.minimal))
		return 0
	}

	// Help passthrough bypasses config, sync, update checks, boot screen, and
	// footer. The wrapper supervises the native child while holding home-keyed
	// session + active-child leases, then performs last-session purge cleanup.
	// Wrapper-only presentation flags are removed before launch.
	if f.helpPassthrough {
		cli, err := codex.FindCLI()
		if err != nil {
			fmt.Fprintln(stderr, "cdx --help:", err)
			return 127
		}
		exit, removed, runErr := runHelpChild(ctx, cli, helpExecArgv(args), stdout, stderr)
		if removed {
			fmt.Fprintln(stderr, "cdx: insecure-host credentials purged")
		}
		if runErr != nil {
			fmt.Fprintln(stderr, "cdx --help:", runErr)
		}
		return exit
	}

	if f.executeInvalid {
		fmt.Fprintln(stderr, "cdx: --execute requires a non-empty prompt argument")
		return 2
	}

	if f.versionFlag {
		fmt.Fprintf(stdout, "cdx %s (commit %s, built %s, %s/%s)\n", Version, Commit, BuildDate, runtime.GOOS, runtime.GOARCH)
		if signing.HasKey() {
			fmt.Fprintln(stdout, "signing pubkey: embedded")
		} else {
			fmt.Fprintln(stdout, "signing pubkey: MISSING (this binary refuses signed configs)")
		}
		return 0
	}

	// Resolve the operator's intent before touching the signed configuration.
	// Status and doctor have dedicated blocked-state renderers when the config
	// is unavailable; every other command fails concisely without starting any
	// lifecycle work.
	sub, subArgs := resolveCommand(f, positional)

	if f.configPath == "" {
		f.configPath = config.DefaultPath()
	}
	pubkey, _ := signing.PublicKey()
	// An expired config is recoverable without an operator: LoadOrRecover
	// refetches with the expired config's own (still signature-verified)
	// credentials before giving up.
	cfg, refreshed, err := fleetconfig.LoadOrRecover(ctx, f.configPath, pubkey, config.EngineCodex)
	if err != nil {
		return configLoadFailure(sub, "cdx", f.configPath, Version, err, stdout, stderr, f.minimal)
	}
	if refreshed {
		fmt.Fprintln(stderr, "cdx: signed config had expired; refreshed it from the orchestrator")
	}

	// Honour silent flag baked into config too.
	if cfg.EngineOptions.Silent {
		f.silent = true
	}

	logger := log.Setup(f.silent, f.debug)
	if exe, exeErr := os.Executable(); exeErr == nil {
		// Startup proves only the selected persona. The signed host engine list
		// may be stale while an admin enable/disable is propagating; authoritative
		// auth/peer reconciliation owns the other alias.
		if _, layoutErr := layout.EnsureAliases(ctx, exe, []string{config.EngineCodex}); layoutErr != nil {
			logger.Warn("cxx layout reconcile skipped", "engine", config.EngineCodex, "err", layoutErr)
		}
	}

	// Every config-backed invocation participates in the same Codex-home keyed
	// session set, including doctor/update/cron/lane and reserved passthroughs.
	// Nested lifecycle/exec/auth calls may take additional shared leases; the
	// durable purge request makes the outermost process the final arbiter.
	if sub != "uninstall" && sub != "logout" {
		outerSession, leaseErr := codex.StartAuthSession(!cfg.Host.Secure)
		if leaseErr != nil {
			fmt.Fprintln(stderr, "cdx: acquire auth session lease:", leaseErr)
			return 1
		}
		defer func() {
			removed, _, finishErr := codex.FinishAuthSession(outerSession)
			if finishErr != nil {
				fmt.Fprintln(stderr, "cdx: auth session cleanup:", finishErr)
				exitCode = 1
			} else if removed {
				fmt.Fprintln(stderr, "cdx: insecure-host credentials purged")
			}
		}()
	}

	// Legacy shorthand: `cdx ls` ↔ `cdx lane spark` — give frequent
	// spark-switchers a one-keystroke path.
	if sub == "ls" {
		sub = "lane"
		subArgs = []string{"spark"}
	}

	// Legacy shorthand: `cdx <profile-name>` dispatches to
	// `codex --profile <name>` when ~/.codex/config.toml has a matching
	// `[profiles.<name>]` section and the token is not one of our internal
	// subcommands. Mirrors fe70ac3:bin/cdx.d/05-main-46-entry.sh.
	if isProfileShorthand(sub) && codex.HasProfile(sub) {
		profileArgs := append([]string{sub}, append(subArgs, passthrough...)...)
		return cmdProfile(ctx, cfg, profileArgs, stderr)
	}

	switch sub {
	case "run":
		exit, err := lifecycle.Run(ctx, lifecycle.Options{
			Config:              cfg,
			ExtraArgs:           append(subArgs, passthrough...),
			SkipBoot:            f.skipBoot || f.silent,
			Minimal:             f.minimal,
			AllowConcurrentSync: f.allowConc,
			Logger:              logger,
			WrapperVersion:      Version,
		})
		printLifecycleError(stderr, "cdx run", err)
		return exit
	case "resume":
		// Interactive like `run`, never Headless like `execute` — resume opens
		// a TTY session picker and a headless run would fail it closed.
		exit, err := lifecycle.Run(ctx, lifecycle.Options{
			Config:              cfg,
			ExtraArgs:           resumeArgs(subArgs, passthrough),
			Resumed:             true,
			SkipBoot:            f.skipBoot || f.silent,
			Minimal:             f.minimal,
			AllowConcurrentSync: f.allowConc,
			Logger:              logger,
			WrapperVersion:      Version,
		})
		printLifecycleError(stderr, "cdx resume", err)
		return exit
	case "exec":
		exit, err := codex.Run(ctx, cfg, append(subArgs, passthrough...))
		if err != nil {
			fmt.Fprintln(stderr, ui.PlainInline("cdx exec: "+err.Error()))
		}
		return exit
	case "execute":
		// Headless one-shot via upstream codex exec.
		//
		// Sandbox and approval policy are deliberately NOT forced here: they
		// come from the fleet-baked config.toml, which the orchestrator owns
		// centrally (`sandbox_mode`, `approval_policy`). Pinning
		// `--sandbox read-only -a untrusted` locally used to override that, and
		// it silently disabled the orchestrator's ENTIRE MCP surface for every
		// headless run — memory, skills and projects alike. Codex requires
		// approval for an MCP tool call under any active sandbox, and a headless
		// run has nobody to approve, so every call came back
		// "user cancelled MCP tool call" while the endpoint itself was healthy.
		// Fleet policy belongs to the fleet config, not to a wrapper constant.
		argv := []string{"exec", "--skip-git-repo-check", f.executePrompt}
		argv = append(argv, append(subArgs, passthrough...)...)
		opts := executeLifecycleOptions(f)
		opts.Config = cfg
		opts.ExtraArgs = argv
		opts.Logger = logger
		opts.WrapperVersion = Version
		exit, err := lifecycle.Run(ctx, opts)
		printLifecycleError(stderr, "cdx execute", err)
		return exit
	case "status":
		return cmdStatus(ctx, cfg, Version, stdout, stderr, f.minimal)
	case "doctor":
		if err := codex.Doctor(ctx, cfg, stdout, Version, f.minimal); err != nil {
			return 1
		}
		return 0
	case "auth-upload":
		return cmdAuthUpload(ctx, cfg, stdout, stderr)
	case "lane":
		return cmdLane(ctx, cfg, subArgs, stdout, stderr)
	case "profile":
		return cmdProfile(ctx, cfg, append(subArgs, passthrough...), stderr)
	case "update":
		theme := ""
		if cfg.EngineOptions.AdminThemeHint != nil {
			theme = *cfg.EngineOptions.AdminThemeHint
		}
		errCaps := commandCaps(ui.DetectCapsFor(stderr, theme), f.minimal)
		artifact, err := resolveWrapperUpdateArtifact(ctx, cfg, Version)
		if err != nil {
			fmt.Fprintln(stderr, ui.UpdateFailure(errCaps, "cdx", "wrapper", Version, err))
			return 1
		}
		fmt.Fprintln(stderr, ui.UpdateProgress(errCaps, "cdx", "wrapper", Version, artifact.Version))
		cfg.Wrapper.Version = artifact.Version
		cfg.Wrapper.BinaryURL = artifact.URL
		cfg.Wrapper.BinarySHA256 = artifact.SHA256
		if err := update.SelfUpdate(ctx, cfg, logger); err != nil {
			fmt.Fprintln(stderr, ui.UpdateFailure(errCaps, "cdx", "wrapper", artifact.Version, err))
			return 1
		}
		outCaps := commandCaps(ui.DetectCapsFor(stdout, theme), f.minimal)
		fmt.Fprintln(stdout, ui.UpdateComplete(outCaps, "cdx", "wrapper", artifact.Version, false))
		return 0
	case "uninstall":
		if err := uninstall.Run(ctx, cfg, stdout, stderr); err != nil {
			fmt.Fprintln(stderr, "cdx uninstall:", err)
			return 1
		}
		return 0
	case "cron":
		return cmdCron(ctx, cfg, subArgs, stdout, stderr, f.minimal)
	default:
		// Reserved upstream subcommands (login, logout, mcp, review, …)
		// passthrough to the real codex binary with the token preserved. The
		// wrapper-owned subcommands above win first — `resume` is reserved but
		// never lands here, since its own case claims it; isHelpPassthrough has
		// already caught `--help` variants.
		if reservedCodexSubcommands[sub] {
			if sub == "logout" {
				before, snapshotErr := codex.CurrentAuthGeneration()
				if snapshotErr != nil {
					fmt.Fprintln(stderr, "cdx logout: could not snapshot local auth state:", snapshotErr)
					return 1
				}
				execArgs := append([]string{sub}, append(subArgs, passthrough...)...)
				exit, marked, deferred, logoutErr := codex.RunExplicitLogout(ctx, cfg, execArgs, before)
				if logoutErr != nil {
					fmt.Fprintln(stderr, ui.PlainInline("cdx logout: "+logoutErr.Error()))
					if exit == 0 {
						return 1
					}
					return exit
				}
				if marked {
					if deferred {
						fmt.Fprintln(stdout, "cdx logout: local logout recorded; native removal deferred until active Codex exits")
					} else {
						fmt.Fprintln(stdout, "cdx logout: local logout recorded")
					}
				}
				return exit
			}
			var authMutationLease *codex.AuthSession
			if sub == "login" {
				authMutationLease, err = codex.StartAuthSession(!cfg.Host.Secure)
				if err != nil {
					fmt.Fprintln(stderr, "cdx "+sub+": acquire auth session lease:", err)
					return 1
				}
			}
			finishAuthMutation := func(code int) int {
				if authMutationLease == nil {
					return code
				}
				removed, _, finishErr := codex.FinishAuthSession(authMutationLease)
				authMutationLease = nil
				if finishErr != nil {
					fmt.Fprintln(stderr, "cdx "+sub+": auth session cleanup:", finishErr)
					return 1
				}
				if removed {
					fmt.Fprintln(stderr, "cdx: insecure-host credentials purged after "+sub)
				}
				return code
			}
			// A successful `cdx login` mints the fleet's most precious
			// credential — snapshot the local auth digest so we can detect the
			// rotation and push it to the orchestrator afterwards. Without
			// this the fresh token only ever existed on this disk, and the
			// next sync clobbered it with the stale fleet canonical.
			beforeDigest := ""
			loginStatus := sub == "login" && loginStatusInvocation(subArgs, passthrough)
			if sub == "login" {
				beforeDigest, err = directLoginDigestSnapshot()
				if err != nil {
					fmt.Fprintln(stderr, "cdx login:", err)
					return finishAuthMutation(1)
				}
			}
			execArgs := append([]string{sub}, append(subArgs, passthrough...)...)
			exit, err := codex.Run(ctx, cfg, execArgs)
			if err != nil {
				fmt.Fprintln(stderr, ui.PlainInline("cdx "+sub+": "+err.Error()))
			}
			if sub == "login" {
				afterDigest, digestErr := directLoginDigestSnapshot()
				if digestErr != nil {
					fmt.Fprintln(stderr, "cdx login:", digestErr)
					return finishAuthMutation(1)
				}
				intent := codex.LogoutIntentGeneration{}
				if exit == 0 && !loginStatus {
					intent, digestErr = codex.CurrentLogoutIntentGeneration()
					if digestErr != nil {
						fmt.Fprintln(stderr, "cdx login: could not inspect logout intent:", digestErr)
						return finishAuthMutation(1)
					}
				}
				if !loginStatus && loginNeedsAuthUpload(exit, beforeDigest, afterDigest, intent.Exists) {
					if code := cmdAuthUpload(ctx, cfg, stdout, stderr); code != 0 {
						fmt.Fprintln(stderr, "cdx login: WARNING; the new credentials were NOT synced to the orchestrator. The fleet still holds the previous token. Retry with `cdx auth-upload`.")
						return finishAuthMutation(loginCompletionExit(exit, code))
					}
				}
			}
			return finishAuthMutation(exit)
		}
		fmt.Fprintln(stderr, "cdx: unknown subcommand:", sub)
		fmt.Fprintln(stderr, "subcommands: run | resume [<session>] | status | doctor | auth-upload | lane <normal|spark|clear> | profile <name> | exec -- <cmd...>")
		fmt.Fprintln(stderr, "flags: --wrapper-help | --version | --status | --doctor | --update | --uninstall | --resume[=<session>] | --execute <prompt> | --cron [install|remove|run] | --silent | --debug | --minimal | --skip-boot | -4 | --allow-concurrent-sync")
		return 2
	}
}

func prepareHelpChildLeases() (*codex.AuthSession, *ipc.Lock, error) {
	session, err := codex.AcquireAuthSession()
	if err != nil {
		return nil, nil, err
	}
	child, err := codex.AcquireActiveChild()
	if err != nil {
		_, _, _ = codex.FinishAuthSession(session)
		return nil, nil, err
	}
	return session, child, nil
}

func runHelpChild(ctx context.Context, cli string, args []string, stdout, stderr io.Writer) (exitCode int, removed bool, err error) {
	session, child, err := prepareHelpChildLeases()
	if err != nil {
		return 1, false, fmt.Errorf("acquire auth safety leases: %w", err)
	}
	finish := func() (bool, error) {
		releaseErr := child.Release()
		removed, _, finishErr := codex.FinishAuthSession(session)
		return removed, errors.Join(releaseErr, finishErr)
	}

	cmd := exec.CommandContext(ctx, cli, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	closeExtras, inheritErr := codex.AttachAuthLeaseFiles(cmd, session, child)
	if inheritErr != nil {
		removed, cleanupErr := finish()
		return 1, removed, errors.Join(fmt.Errorf("inherit auth safety leases: %w", inheritErr), cleanupErr)
	}
	if startErr := cmd.Start(); startErr != nil {
		bridgeErr := closeExtras()
		removed, cleanupErr := finish()
		return 127, removed, errors.Join(fmt.Errorf("start failed: %w", startErr), bridgeErr, cleanupErr)
	}
	bridgeErr := closeExtras()
	waitErr := cmd.Wait()
	removed, cleanupErr := finish()

	exitCode = 0
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			exitCode = exitErr.ExitCode()
			if exitCode < 0 {
				if ctx.Err() != nil {
					exitCode = 130
				} else {
					exitCode = 1
				}
			}
		} else {
			exitCode = 1
			err = fmt.Errorf("wait for native help: %w", waitErr)
		}
	}
	if bridgeErr != nil || cleanupErr != nil {
		err = errors.Join(err, fmt.Errorf("release auth safety leases: %w", errors.Join(bridgeErr, cleanupErr)))
		if exitCode == 0 {
			exitCode = 1
		}
	}
	return exitCode, removed, err
}

func executeLifecycleOptions(f flags) lifecycle.Options {
	return lifecycle.Options{
		SkipBoot:            true,
		Headless:            true,
		Minimal:             f.minimal,
		AllowConcurrentSync: f.allowConc,
	}
}

func printLifecycleError(w io.Writer, prefix string, err error) {
	if err == nil || lifecycle.ErrorWasPresented(err) {
		return
	}
	fmt.Fprintln(w, ui.PlainInline(prefix+": "+err.Error()))
}

// commandCaps applies explicit --minimal after terminal detection. Keeping the
// override at dispatch means help, doctor, and update cannot accidentally grow
// a separate interpretation of "minimal".
func commandCaps(caps ui.Caps, minimal bool) ui.Caps {
	if minimal {
		return ui.MinimalCaps(caps)
	}
	return caps
}

func configLoadFailure(sub, engine, path, wrapperVersion string, loadErr error, stdout, stderr io.Writer, minimal bool) int {
	detail := boundedPlain(loadErrString(loadErr), 240)
	configPath := boundedPlain(path, 160)
	if configPath == "" {
		configPath = "the configured path"
	}

	switch sub {
	case "status":
		state := ui.ScreenInput{
			WrapperVersion: wrapperVersion,
			WrapperTone:    ui.ToneOK,
			CodexVersion:   "unknown",
			CodexTone:      ui.ToneWarn,
			Dots: []ui.HealthDot{
				{Name: "config", Tone: ui.ToneFail},
			},
			ResultLabel: fmt.Sprintf("config=unreadable. Reinstall or repair the signed wrapper config, then run `%s status` again. Path: %s. Cause: %s.", engine, configPath, detail),
			ResultTone:  ui.ToneFail,
		}
		if minimal {
			ui.PrintMinimalScreen(stdout, state)
		} else {
			ui.PrintBootScreen(stdout, state)
		}
		return 1
	case "doctor":
		report := ui.DoctorReport{
			Engine: engine,
			When:   time.Now(),
			Rows: []ui.DoctorRow{
				{Label: "Config", Tone: ui.ToneFail, Value: "signed wrapper configuration unavailable: " + detail},
			},
			Hints: []string{
				fmt.Sprintf("Repair %s and its .sig file, then run `%s doctor` again.", configPath, engine),
			},
			Result: ui.DoctorRow{Label: "Result", Tone: ui.ToneFail, Value: "diagnostics blocked until the wrapper configuration is repaired"},
		}
		caps := commandCaps(ui.DetectCapsFor(stdout, ""), minimal)
		ui.PrintDoctor(stdout, caps, report)
		return 1
	default:
		printBoundedPlain(stderr, engine+": config unavailable: "+detail, minimal)
		return 2
	}
}

func printBoundedPlain(w io.Writer, value string, minimal bool) {
	caps := commandCaps(ui.DetectCapsFor(w, ""), minimal)
	if !caps.IsTTY {
		caps = ui.MinimalCaps(caps)
	}
	width := caps.Columns
	if width <= 0 {
		width = 80
	}
	fmt.Fprintln(w, ui.TruncateText(ui.PlainInline(value), width, caps))
}

func loadErrString(err error) string {
	if err == nil {
		return "unknown configuration error"
	}
	return err.Error()
}

func boundedPlain(value string, width int) string {
	return ui.TruncateText(ui.PlainInline(value), width, ui.Caps{Dumb: true})
}

type wrapperUpdateArtifact struct {
	Version string
	URL     string
	SHA256  string
}

func resolveWrapperUpdateArtifact(ctx context.Context, cfg *config.Config, current string) (wrapperUpdateArtifact, error) {
	if cfg == nil {
		return wrapperUpdateArtifact{}, fmt.Errorf("wrapper config unavailable")
	}
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err == nil {
		if resp, rerr := client.AuthRetrieve(ctx, ""); rerr == nil && resp != nil {
			if err := updateCommandAuthSessionSecurity(resp); err != nil {
				return wrapperUpdateArtifact{}, fmt.Errorf("update auth session security state: %w", err)
			}
			if artifact, ok := artifactFromVersionSummary(resp.Versions); ok {
				return validateWrapperUpdateArtifact(artifact, current)
			}
			switch strings.ToLower(strings.TrimSpace(resp.Status)) {
			case "insecure":
				return wrapperUpdateArtifact{}, fmt.Errorf("insecure host approval pending; open the host window first")
			case "insecure-denied":
				return wrapperUpdateArtifact{}, fmt.Errorf("insecure host approval denied")
			}
		}
	}
	return validateWrapperUpdateArtifact(wrapperUpdateArtifact{
		Version: cfg.Wrapper.Version,
		URL:     cfg.Wrapper.BinaryURL,
		SHA256:  cfg.Wrapper.BinarySHA256,
	}, current)
}

func artifactFromVersionSummary(v *orchestrator.VersionSummary) (wrapperUpdateArtifact, bool) {
	if v == nil || !v.AutoUpdateEnabled || v.WrapperVersion == nil || v.WrapperURL == nil || v.WrapperSHA256 == nil {
		return wrapperUpdateArtifact{}, false
	}
	artifact := wrapperUpdateArtifact{
		Version: strings.TrimSpace(*v.WrapperVersion),
		URL:     strings.TrimSpace(*v.WrapperURL),
		SHA256:  strings.TrimSpace(*v.WrapperSHA256),
	}
	if artifact.Version == "" || artifact.URL == "" || artifact.SHA256 == "" {
		return wrapperUpdateArtifact{}, false
	}
	return artifact, true
}

func validateWrapperUpdateArtifact(artifact wrapperUpdateArtifact, current string) (wrapperUpdateArtifact, error) {
	if artifact.Version == "" || artifact.URL == "" || artifact.SHA256 == "" {
		return wrapperUpdateArtifact{}, fmt.Errorf("wrapper update metadata incomplete")
	}
	cmp, ok := compareSemver(artifact.Version, current)
	if !ok {
		return wrapperUpdateArtifact{}, fmt.Errorf("refusing wrapper update: cannot verify %s is not a downgrade from %s", artifact.Version, current)
	}
	if cmp < 0 {
		return wrapperUpdateArtifact{}, fmt.Errorf("refusing to downgrade wrapper from %s to %s", current, artifact.Version)
	}
	return artifact, nil
}

func compareSemver(a, b string) (int, bool) {
	av, okA := parseSemverTriple(a)
	bv, okB := parseSemverTriple(b)
	if !okA || !okB {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if av[i] < bv[i] {
			return -1, true
		}
		if av[i] > bv[i] {
			return 1, true
		}
	}
	return 0, true
}

func parseSemverTriple(v string) ([3]int, bool) {
	var out [3]int
	base := strings.TrimPrefix(strings.TrimSpace(v), "v")
	if idx := strings.IndexAny(base, "+-"); idx >= 0 {
		base = base[:idx]
	}
	parts := strings.Split(base, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// parseFlags pulls flags + positional args out of argv, honouring "--" as
// passthrough sentinel.
//
// Help passthrough is detected first so reserved Codex subcommands like
// `cdx exec --help` route straight to the upstream binary without the wrapper
// rejecting any unknown flags.
func parseFlags(args []string) (flags, []string, []string) {
	var f flags
	wrapperHelp := wrapperHelpRequested(args)
	if !wrapperHelp && isHelpPassthrough(args) {
		f.helpPassthrough = true
		return f, nil, nil
	}
	var positional []string
	var passthrough []string
	consumedDash := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if consumedDash {
			passthrough = append(passthrough, a)
			continue
		}
		switch {
		case a == "--":
			consumedDash = true
		case a == "--help" || a == "-h":
			if wrapperHelp {
				continue
			}
			// Safety net: isHelpPassthrough should already have caught any
			// bare --help/-h above, but if some combination slips through,
			// don't let it fall into `positional` and get misdispatched as
			// an unknown subcommand.
			f.helpPassthrough = true
			return f, nil, nil
		case a == "--version" || a == "-V" || a == "--wrapper-version" || a == "-W":
			f.versionFlag = true
		case a == "--wrapper-help":
			f.wrapperHelp = true
		case a == "--update" || a == "-U":
			f.updateFlag = true
		case a == "--uninstall":
			f.uninstallFlag = true
		case a == "--status":
			f.statusFlag = true
		case a == "--doctor":
			f.doctorFlag = true
		case a == "--silent":
			f.silent = true
		case a == "--debug" || a == "--verbose":
			f.debug = true
			_ = os.Setenv("CODEX_DEBUG", "1")
		case a == "--minimal" || a == "--minimal-output":
			f.minimal = true
		case a == "--skip-boot" || a == "--no-banner":
			f.skipBoot = true
		case a == "-4" || a == "--ipv4":
			f.forceIPv4 = true
			_ = os.Setenv("CODEX_FORCE_IPV4", "1")
		case a == "--allow-concurrent-sync":
			f.allowConc = true
		case a == "--cron":
			f.cronArgs = []string{}
			if i+1 < len(args) {
				next := args[i+1]
				if !strings.HasPrefix(next, "-") {
					f.cronArgs = []string{next}
					i++
				}
			}
		case a == "--execute":
			if i+1 < len(args) && strings.TrimSpace(args[i+1]) != "" {
				f.executePrompt = args[i+1]
				i++
			} else {
				f.executeInvalid = true
				if i+1 < len(args) {
					i++
				}
			}
		// --resume is a wrapper-level alias for the upstream `codex resume`
		// subcommand; upstream has no --resume flag and rejects it outright, so
		// the token must never reach passthrough. See resumeArgs.
		case a == "--resume":
			f.resumeFlag = true
			f.resumeSession = ""
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				f.resumeSession = args[i+1]
				i++
			}
		case strings.HasPrefix(a, "--resume="):
			f.resumeFlag = true
			f.resumeSession = strings.TrimPrefix(a, "--resume=")
		case a == "--config" && i+1 < len(args):
			f.configPath = args[i+1]
			i++
		case strings.HasPrefix(a, "--config="):
			f.configPath = strings.TrimPrefix(a, "--config=")
		default:
			positional = append(positional, a)
		}
	}
	return f, positional, passthrough
}

func wrapperHelpRequested(args []string) bool {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			return false
		}
		if a == "--wrapper-help" {
			return true
		}
		switch a {
		case "--execute", "--config":
			if i+1 < len(args) {
				i++
			}
		case "--resume", "--cron":
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
			}
		}
	}
	return false
}

// resolveCommand normalises wrapper flags and positional subcommands onto one
// dispatch shape. Keeping this pure makes aliases testable without loading a
// signed config or invoking the networked lifecycle.
func resolveCommand(f flags, positional []string) (string, []string) {
	sub := "run"
	subArgs := positional
	if len(positional) > 0 {
		sub = positional[0]
		subArgs = positional[1:]
	}

	switch {
	case f.updateFlag:
		sub = "update"
	case f.uninstallFlag:
		sub = "uninstall"
	case f.statusFlag:
		sub = "status"
	case f.doctorFlag:
		sub = "doctor"
	case f.cronArgs != nil:
		sub = "cron"
		subArgs = f.cronArgs
	case f.executePrompt != "":
		sub = "execute"
		subArgs = positional
	case f.resumeFlag:
		// Resume intent came from a flag, so positional contains only real
		// resume arguments and must not lose its first element as a subcommand.
		sub = "resume"
		subArgs = positional
		if f.resumeSession != "" {
			subArgs = append([]string{f.resumeSession}, subArgs...)
		}
	}

	return sub, subArgs
}

func conflictingActions(f flags, positional []string) []string {
	actions := []string{}
	seen := map[string]bool{}
	add := func(enabled bool, key, label string) {
		if enabled && !seen[key] {
			seen[key] = true
			actions = append(actions, label)
		}
	}
	add(f.wrapperHelp, "help", "--wrapper-help")
	add(f.versionFlag, "version", "--version")
	add(f.updateFlag, "update", "--update")
	add(f.uninstallFlag, "uninstall", "--uninstall")
	add(f.statusFlag, "status", "--status")
	add(f.doctorFlag, "doctor", "--doctor")
	add(f.cronArgs != nil, "cron", "--cron")
	add(f.executePrompt != "" || f.executeInvalid, "execute", "--execute")
	add(f.resumeFlag, "resume", "--resume")
	if !f.resumeFlag && f.executePrompt == "" && !f.executeInvalid && len(positional) > 0 && wrapperOwnedSubcommands[positional[0]] {
		add(true, positional[0], positional[0])
	}
	return actions
}

// cmdStatus runs auth-retrieve + renders the boot screen.
func cmdStatus(ctx context.Context, cfg *config.Config, wrapperVersion string, stdout, stderr io.Writer, minimal bool) (exitCode int) {
	authSessionLease, leaseErr := codex.StartAuthSession(!cfg.Host.Secure)
	if leaseErr != nil {
		fmt.Fprintln(stderr, "cdx status: acquire auth session lease:", leaseErr)
		return 1
	}
	defer func() {
		removed, _, err := codex.FinishAuthSession(authSessionLease)
		if err != nil {
			fmt.Fprintln(stderr, "cdx status: auth session cleanup:", err)
			exitCode = 1
		} else if removed {
			fmt.Fprintln(stderr, "cdx status: insecure-host credentials purged")
		}
	}()
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		fmt.Fprintln(stderr, "cdx status:", err)
		return 1
	}
	logoutHold, err := codex.LogoutIntentActive()
	if err != nil {
		fmt.Fprintln(stderr, "cdx status: inspect logout intent:", err)
		return 1
	}
	expected, err := codex.CurrentAuthGeneration()
	if err != nil {
		fmt.Fprintln(stderr, "cdx status: snapshot local auth:", err)
		return 1
	}
	if !logoutHold && expected.Exists {
		_, stabilized, stabilizeErr := codex.ReadAuthForUpload()
		if errors.Is(stabilizeErr, os.ErrNotExist) {
			expected, stabilizeErr = codex.CurrentAuthGeneration()
		}
		if stabilizeErr != nil {
			fmt.Fprintln(stderr, "cdx status: stabilize local auth:", stabilizeErr)
			return 1
		}
		expected = stabilized
	}
	digest := expected.Digest
	resp, authErr := client.AuthRetrieve(ctx, digest)
	if securityErr := updateCommandAuthSessionSecurity(resp); securityErr != nil {
		authErr = errors.Join(authErr, fmt.Errorf("update auth session security state: %w", securityErr))
	}
	authSynced := false
	if authErr == nil && !logoutHold && resp != nil && len(resp.Auth) > 0 && !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "failed") {
		switch strings.ToLower(strings.TrimSpace(resp.Status)) {
		case "outdated", "updated", "missing":
			authPath, _ := codex.AuthPath()
			definitiveFallback := resp.CandidateRejectedDefinitive && strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified")
			if !statusCanonicalAuthMayReplace(authPath, resp.Auth) && !definitiveFallback {
				break
			}
			result, err := codex.ConvergeAuthIfCurrent(resp.Auth, expected)
			if err != nil {
				authErr = fmt.Errorf("apply canonical auth: %w", err)
			} else if result.Written {
				authSynced = true
			} else if _, outcomeErr := classifyBlockedAuthWrite(authPath, expected, result); outcomeErr != nil {
				authErr = outcomeErr
			}
		}
	}
	if !logoutHold {
		finalLogout, finalErr := codex.LogoutIntentActive()
		if finalErr != nil {
			authErr = errors.Join(authErr, fmt.Errorf("inspect logout intent after status request: %w", finalErr))
		} else {
			logoutHold = finalLogout
		}
	}
	if logoutHold {
		if resp == nil {
			resp = &orchestrator.AuthRetrieveResponse{}
		}
		resp.Status = "missing"
		resp.Auth = nil
		resp.VerificationState = ""
		resp.Message = "Explicitly logged out locally; run `cdx login` to authenticate again."
		authSynced = false
	}
	state := summary.Build(ctx, summary.Inputs{
		Config:         cfg,
		WrapperVersion: wrapperVersion,
		Auth:           resp,
		AuthErr:        authErr,
		AuthSynced:     authSynced,
		StatusOnly:     true,
	})
	if logoutHold {
		state.ResultLabel = "Explicitly logged out locally; run `cdx login` to authenticate again."
		state.ResultTone = ui.ToneFail
	}
	if minimal {
		ui.PrintMinimalScreen(stdout, state)
	} else {
		ui.PrintBootScreen(stdout, state)
	}
	if state.ResultTone == ui.ToneFail {
		return 1
	}
	return 0
}

func updateCommandAuthSessionSecurity(resp *orchestrator.AuthRetrieveResponse) error {
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

// classifyBlockedAuthWrite distinguishes a genuine CAS winner from the same
// expected generation being unwritable solely because a native child still
// owns it. Only the former may be preserved as a newer local login.
func classifyBlockedAuthWrite(authPath string, expected codex.AuthGeneration, result codex.AuthConvergenceResult) (keptNewer bool, err error) {
	if result.AlreadyCurrent {
		return false, nil
	}
	if result.KeptNewerGeneration {
		return true, nil
	}
	if result.Current != expected {
		if !codex.IsValidLocalAuth(authPath) {
			return false, errors.New("canonical auth was required but a changed unusable local generation prevented materialization")
		}
		return false, errors.New("canonical auth was required but a changed local generation could not be converged")
	}
	if result.BlockedByActiveChild {
		return false, errors.New("canonical auth was required but the unchanged local generation is still owned by a native Codex child")
	}
	return false, errors.New("canonical auth was required but could not be materialized")
}

// statusCanonicalAuthMayReplace prevents a read-only-looking status check from
// destroying a newer local login when the fleet has not adopted it yet. An
// absent/unreadable local file may be repaired; an existing local file wins
// over a canonical payload with no usable freshness stamp.
func statusCanonicalAuthMayReplace(localPath string, canonical []byte) bool {
	if codex.IsValidLocalAuth(localPath) == false {
		return true
	}
	localTime, err := codex.LastRefreshOfFile(localPath)
	if err != nil {
		return true
	}
	canonicalTime, err := codex.LastRefreshFromRaw(canonical)
	if err != nil {
		return false
	}
	return !localTime.After(canonicalTime)
}

func cmdLane(ctx context.Context, cfg *config.Config, args []string, stdout, stderr io.Writer) int {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		fmt.Fprintln(stderr, "lane:", err)
		return 1
	}

	clear := false
	target := ""
	for _, a := range args {
		switch a {
		case "--persist":
			// Kept as a compatibility no-op: explicit lane selections are
			// server-side preferences and therefore always persist.
		case "clear":
			clear = true
		case "normal", "spark":
			if target != "" && target != a {
				fmt.Fprintln(stderr, "lane: choose exactly one of normal, spark, or clear")
				return 2
			}
			target = a
		default:
			fmt.Fprintln(stderr, "lane: unrecognized argument:", a)
			fmt.Fprintln(stderr, "usage: cdx lane [normal|spark|clear] [--persist]")
			return 2
		}
	}
	if clear && target != "" {
		fmt.Fprintln(stderr, "lane: clear cannot be combined with "+target)
		return 2
	}

	if clear {
		if err := client.ClearLane(ctx); err != nil {
			fmt.Fprintln(stderr, "lane clear:", err)
			return 1
		}
		fmt.Fprintln(stdout, "lane: cleared (inherited default; effective normal)")
		return 0
	}

	if target == "" {
		lane, err := client.GetLane(ctx)
		if err != nil {
			fmt.Fprintln(stderr, "lane:", err)
			return 1
		}
		fmt.Fprintf(stdout, "lane: %s (effective)\n", lane)
		return 0
	}

	if err := client.SetLane(ctx, target); err != nil {
		fmt.Fprintln(stderr, "lane:", err)
		return 1
	}
	fmt.Fprintf(stdout, "lane: %s (persisted)\n", target)
	return 0
}

func cmdProfile(ctx context.Context, cfg *config.Config, args []string, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: cdx profile <name> [-- codex args...]")
		return 2
	}
	exit, err := codex.Run(ctx, cfg, append([]string{"--profile", args[0]}, args[1:]...))
	if err != nil {
		fmt.Fprintln(stderr, "profile:", err)
	}
	return exit
}

// loginRotatedAuth reports whether a completed `cdx login` actually minted new
// local credentials worth uploading: the upstream CLI exited 0 and the
// auth.json digest changed to a non-empty value. `codex login status` and
// aborted logins leave the digest untouched and must not trigger an upload.
func loginRotatedAuth(exit int, beforeDigest, afterDigest string) bool {
	return exit == 0 && afterDigest != "" && afterDigest != beforeDigest
}

func loginNeedsAuthUpload(exit int, beforeDigest, afterDigest string, logoutIntentExists bool) bool {
	// Every successful real login must prove the resulting credential through
	// the API/runner, even when the bytes happen to match the pre-login file.
	// The caller filters the read-only `login status` form separately.
	_ = beforeDigest
	_ = logoutIntentExists
	return exit == 0 && afterDigest != ""
}

// loginStatusInvocation recognizes the read-only upstream status probe. A
// byte-identical credential plus an old logout marker is intentionally enough
// to upload after a real successful login, but never after `codex login status`.
func loginStatusInvocation(subArgs, passthrough []string) bool {
	args := append(append([]string(nil), subArgs...), passthrough...)
	for _, arg := range args {
		if arg == "--" {
			continue
		}
		if strings.HasPrefix(arg, "-") {
			continue
		}
		return arg == "status"
	}
	return false
}

func loginCompletionExit(upstreamExit, uploadExit int) int {
	if uploadExit != 0 {
		return uploadExit
	}
	return upstreamExit
}

func directLoginDigestSnapshot() (string, error) {
	digest, err := codex.LocalDigest()
	if err != nil {
		return "", fmt.Errorf("could not read local auth digest: %w", err)
	}
	return digest, nil
}

func logoutGenerationMayBeMarked(before, after codex.AuthGeneration, authPath string) bool {
	return after == before || !after.Exists || !codex.IsValidLocalAuth(authPath)
}

// cmdAuthUpload pushes a locally-edited auth.json to the orchestrator.
func cmdAuthUpload(ctx context.Context, cfg *config.Config, stdout, stderr io.Writer) (exitCode int) {
	authSessionLease, leaseErr := codex.StartAuthSession(!cfg.Host.Secure)
	if leaseErr != nil {
		fmt.Fprintln(stderr, "auth-upload: acquire auth session lease:", leaseErr)
		return 1
	}
	defer func() {
		removed, _, err := codex.FinishAuthSession(authSessionLease)
		if err != nil {
			fmt.Fprintln(stderr, "auth-upload: auth session cleanup:", err)
			exitCode = 1
		} else if removed {
			fmt.Fprintln(stderr, "auth-upload: insecure-host credentials purged")
		}
	}()
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	storeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	for attempt := 0; attempt < 2; attempt++ {
		upload, err := codex.BeginAuthUpload(true)
		if err != nil {
			fmt.Fprintln(stderr, "auth-upload:", err)
			return 1
		}
		expected := upload.Generation()
		resp, err := client.AuthStore(storeCtx, upload.Payload())
		if err != nil {
			_ = upload.Close()
			fmt.Fprintln(stderr, "auth-upload:", err)
			return 1
		}
		if !resp.AuthCandidateAccepted() {
			closeErr := upload.Close()
			if err := updateCommandAuthSessionSecurity(resp); err != nil {
				fmt.Fprintln(stderr, "auth-upload: update auth session security state:", err)
				return 1
			}
			if closeErr != nil {
				fmt.Fprintln(stderr, "auth-upload: rejected upload transaction cleanup:", closeErr)
				return 1
			}
			status := ""
			if resp != nil {
				status = resp.Status
			}
			fmt.Fprintf(stderr, "auth-upload: server did not accept the uploaded Codex credential generation (status %q)\n", status)
			return 1
		}
		// Native Codex does not honor the wrapper flock. Confirm that the exact
		// accepted generation is still current; one overlap gets one bounded
		// retry, while a second change fails visibly instead of claiming success.
		acknowledged, ackErr := upload.AcknowledgeObservedLogout()
		closeErr := upload.Close()
		if ackErr != nil {
			fmt.Fprintln(stderr, "auth-upload: accepted by server but logout marker cleanup failed:", ackErr)
			return 1
		}
		if closeErr != nil {
			fmt.Fprintln(stderr, "auth-upload: accepted by server but auth transaction cleanup failed:", closeErr)
			return 1
		}
		if err := updateCommandAuthSessionSecurity(resp); err != nil {
			fmt.Fprintln(stderr, "auth-upload: update auth session security state:", err)
			return 1
		}
		if !acknowledged {
			if attempt == 0 {
				continue
			}
			fmt.Fprintln(stderr, "auth-upload: local credentials changed during both upload attempts; latest generation was not verified")
			return 1
		}
		if resp != nil && len(resp.Auth) > 0 && !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "failed") {
			if result, writeErr := codex.ConvergeAuthIfCurrent(resp.Auth, expected); writeErr != nil {
				fmt.Fprintln(stderr, "auth-upload: accepted by server but local writeback failed:", writeErr)
				return 1
			} else if !result.Written {
				if logoutActive, logoutErr := codex.LogoutIntentActive(); logoutErr == nil && logoutActive {
					fmt.Fprintln(stdout, "auth-upload: accepted; a later local logout was kept")
					return 0
				}
				authPath, _ := codex.AuthPath()
				kept, outcomeErr := classifyBlockedAuthWrite(authPath, expected, result)
				if outcomeErr != nil {
					fmt.Fprintln(stderr, "auth-upload: server accepted the upload but canonical credentials could not be materialized locally:", outcomeErr)
					return 1
				}
				if kept {
					fmt.Fprintln(stderr, "auth-upload: server accepted the upload; a newer local login was kept")
				}
			}
		}
		fmt.Fprintln(stdout, "auth-upload: ok")
		return 0
	}
	return 1
}

func cmdCron(ctx context.Context, cfg *config.Config, args []string, stdout, stderr io.Writer, minimal bool) int {
	action := "run"
	if len(args) > 0 {
		action = args[0]
	}
	switch action {
	case "install":
		if err := hostcron.Install(ctx, cfg); err != nil {
			printBoundedPlain(stderr, "cdx --cron install: "+err.Error(), minimal)
			return 1
		}
		fmt.Fprintln(stdout, "cron: installed")
		return 0
	case "remove":
		if err := hostcron.Remove(ctx); err != nil {
			printBoundedPlain(stderr, "cdx --cron remove: "+err.Error(), minimal)
			return 1
		}
		fmt.Fprintln(stdout, "cron: removed")
		return 0
	case "run":
		if !hostcron.IsEngineOnly() {
			if err := hostcron.Run(ctx, cfg, minimal, stdout, stderr); err != nil {
				printBoundedPlain(stderr, "cxx cron: "+err.Error(), minimal)
				return 1
			}
			return 0
		}
		// Non-interactive auto-update tick.
		res, err := enginecron.TickWithOptions(ctx, cfg, minimal)
		if err != nil {
			printBoundedPlain(stderr, "cdx --cron: "+err.Error(), minimal)
			return 1
		}
		printBoundedPlain(stdout, formatCronResult(res, minimal), minimal)
		return 0
	default:
		printBoundedPlain(stderr, "cdx cron: unknown action: "+action, minimal)
		fmt.Fprintln(stderr, "usage: cdx cron [install|remove|run]")
		return 2
	}
}

// formatCronResult renders a one-line summary of a cron Tick for human
// consumption. The current invocation either updated something, kept things
// as-is, or saw the server disable cron entirely; the line states which and
// names the versions involved so `cdx --cron` is never silent on success.
func formatCronResult(r enginecron.Result, minimal bool) string {
	arrow := "→"
	if minimal {
		arrow = "->"
	}
	switch {
	case r.WrapperAction == "disable":
		return "cron: auto-update disabled by server; cron job removed"
	case r.WrapperAction == "updated":
		return fmt.Sprintf("cron: wrapper updated %s %s %s (re-exec)", r.WrapperVersion, arrow, r.WrapperTarget)
	case r.CodexAction == "updated":
		return fmt.Sprintf("cron: codex updated %s %s %s (wrapper %s, reported=%t)", r.CodexBefore, arrow, r.CodexVersion, r.WrapperVersion, r.Reported)
	default:
		return fmt.Sprintf("cron: ok (wrapper %s, codex %s, no updates, reported=%t)", r.WrapperVersion, r.CodexVersion, r.Reported)
	}
}

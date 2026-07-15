// clx — Codex Orchestrator wrapper, engine=claude.
//
// Subcommands: run (default), resume, status, doctor, exec, auth-upload,
// --version, --update, --uninstall, --cron [install|remove|run], --execute,
// -r/--resume, --continue,
// --dangerously-skip-permissions (per-run only; forwarded to `claude`, never
// persisted to the fleet-managed permissions.defaultMode).
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/log"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/signing"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/uninstall"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/update"
)

// maxRestartDepth caps how many times the wrapper may re-exec itself after a
// self-update before bailing out. Each self-update increments
// CLAUDE_WRAPPER_RESTART_DEPTH; >2 strongly implies a feedback loop.
const maxRestartDepth = 2

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

type flags struct {
	configPath      string
	silent          bool
	debug           bool
	minimal         bool
	skipBoot        bool
	versionFlag     bool
	updateFlag      bool
	uninstallFlag   bool
	statusFlag      bool
	doctorFlag      bool
	wrapperHelp     bool
	cronArgs        []string
	executePrompt   string
	executeInvalid  bool
	forceIPv4       bool
	allowConc       bool
	helpPassthrough bool
	// Forwarded straight to the upstream Claude CLI through the normal
	// lifecycle. Recognised so parseFlags doesn't reject them.
	continueSession bool
	// resumeFlag records that --resume/-r was given at all; resumeSession holds
	// its optional value. The two are distinct because a bare --resume is a
	// valid request for the upstream session picker, which resumeSession == ""
	// cannot express on its own.
	resumeFlag    bool
	resumeSession string
	// dangerouslySkipPermissions forwards --dangerously-skip-permissions to the
	// upstream claude binary (bypasses all tool-permission prompts for this run
	// only) and lights a boot-screen warning badge; it is never persisted, so
	// the fleet-managed permissions.defaultMode is unaffected.
	dangerouslySkipPermissions bool
}

// reservedClaudeSubcommands lists Claude CLI subcommands whose `--help`
// invocations route straight to the upstream binary.
//
// `resume` stays listed so `clx resume --help` renders upstream help; the
// wrapper-owned `case "resume"` in run() handles every non-help invocation and
// takes precedence over the default passthrough branch. `sessions` is
// deliberately absent: Claude has no such subcommand, so passing it through
// made `clx sessions` hang as a literal prompt. Failing fast with "unknown
// subcommand" is the honest answer.
var reservedClaudeSubcommands = map[string]bool{
	"auth":   true,
	"login":  true,
	"logout": true,
	"mcp":    true,
	"config": true,
	"doctor": true,
	"resume": true,
	"help":   true,
}

var wrapperOwnedSubcommands = map[string]bool{
	"run": true, "resume": true, "status": true, "doctor": true,
	"auth-upload": true, "update": true, "uninstall": true,
	"cron": true, "execute": true, "exec": true,
}

// resumeArgs builds the upstream argv for a resume request. Claude spells
// resume as a flag with an optional value (`claude -r/--resume [value]`), not a
// subcommand — `claude resume` is swallowed as a prompt and opens a brand-new
// session. Both `clx resume ...` and `clx --resume <id> ...` funnel through
// here, which is what keeps the two spellings from drifting apart again.
//
// A leading "-" in rest needs no guard: --resume's value is optional, so
// `claude --resume --foo` parses as picker + --foo, which is what was meant.
func resumeArgs(rest, passthrough []string) []string {
	out := append([]string{"--resume"}, rest...)
	return append(out, passthrough...)
}

// isHelpPassthrough returns true when argv requests upstream Claude help text.
// Matched forms:
//   - top-level `--help` / `-h` appearing before any positional token
//   - bare `help` as the first positional token
//   - `<reserved-subcommand> ... --help` / `<reserved-subcommand> ... -h`
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
		switch a {
		case "--execute", "--config":
			if i+1 < len(args) {
				i++
			}
			continue
		case "--resume", "-r", "--cron":
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
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
	if firstPositional == "help" {
		return true
	}
	if helpBeforePositional {
		return true
	}
	if firstPositional != "" && reservedClaudeSubcommands[firstPositional] {
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

// helpExecArgv rewrites the argv used for help passthrough so the upstream
// Claude CLI actually renders help. Unlike `codex help`, `claude help` treats
// `help` as a prompt and opens an interactive session (which hangs a
// non-interactive caller), so a bare leading `help` positional token is
// rewritten to `--help`. Every other help form (`--help`, `-h`,
// `<subcommand> --help`) already renders help upstream and is forwarded
// verbatim.
func helpExecArgv(args []string) []string {
	out := append([]string(nil), args...)
	for i, a := range out {
		if a == "--" {
			break
		}
		if strings.HasPrefix(a, "-") {
			continue
		}
		// First positional token: only a bare `help` needs rewriting.
		if a == "help" {
			out[i] = "--help"
		}
		break
	}
	return out
}

func run(args []string, stdout, stderr io.Writer) int {
	depth, _ := strconv.Atoi(os.Getenv("CLAUDE_WRAPPER_RESTART_DEPTH"))
	if depth > maxRestartDepth {
		fmt.Fprintf(stderr, "clx: restart depth %d exceeded cap %d — refusing to continue\n", depth, maxRestartDepth)
		return 70
	}

	snap := make([]string, len(args))
	copy(snap, args)
	update.SnapshottedArgv = snap

	cron.WrapperVersion = Version

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	f, positional, passthrough := parseFlags(args)
	if actions := conflictingActions(f, positional); len(actions) > 1 {
		fmt.Fprintln(stderr, "clx: conflicting wrapper actions:", strings.Join(actions, ", "))
		return 2
	}

	if f.wrapperHelp {
		ui.PrintWrapperHelp(stdout, ui.DetectCapsFor(stdout, ""))
		return 0
	}

	// Help passthrough bypasses every wrapper side effect: no lock, no sync,
	// no update check, no boot screen, no footer. argv is forwarded as-is except
	// that a bare leading `help` token is rewritten to `--help` (see
	// helpExecArgv) so the upstream Claude CLI renders help instead of opening an
	// interactive session.
	if f.helpPassthrough {
		cli, err := claude.FindCLI()
		if err != nil {
			fmt.Fprintln(stderr, "clx --help:", err)
			return 127
		}
		execArgv := append([]string{cli}, helpExecArgv(args)...)
		if err := syscall.Exec(cli, execArgv, os.Environ()); err != nil {
			fmt.Fprintln(stderr, "clx --help: exec failed:", err)
			return 127
		}
		return 0
	}

	if f.executeInvalid {
		fmt.Fprintln(stderr, "clx: --execute requires a non-empty prompt argument")
		return 2
	}

	if f.versionFlag {
		fmt.Fprintf(stdout, "clx %s (commit %s, built %s, %s/%s)\n", Version, Commit, BuildDate, runtime.GOOS, runtime.GOARCH)
		if signing.HasKey() {
			fmt.Fprintln(stdout, "signing pubkey: embedded")
		} else {
			fmt.Fprintln(stdout, "signing pubkey: MISSING (this binary refuses signed configs)")
		}
		return 0
	}

	if f.configPath == "" {
		p, err := config.DefaultPath()
		if err != nil {
			fmt.Fprintln(stderr, "clx:", err)
			return 2
		}
		f.configPath = p
	}
	pubkey, _ := signing.PublicKey()
	cfg, err := config.Load(f.configPath, pubkey, false)
	if err != nil {
		sub, _ := resolveCommand(f, positional)
		if sub == "status" {
			fmt.Fprintf(stdout, "clx | status=blocked | wrapper=%s | config=unreadable\n", ui.CleanInline(Version))
			fmt.Fprintln(stdout, "result | "+ui.CleanInline(err.Error()))
			return 1
		}
		fmt.Fprintln(stderr, err)
		return 2
	}

	if cfg.EngineOptions.Silent {
		f.silent = true
	}

	logger := log.Setup(f.silent, f.debug)
	sub, subArgs := resolveCommand(f, positional)

	switch sub {
	case "run":
		exit, err := lifecycle.Run(ctx, lifecycle.Options{
			Config:                     cfg,
			ExtraArgs:                  append(subArgs, passthrough...),
			SkipBoot:                   f.skipBoot || f.silent,
			Minimal:                    f.minimal,
			AllowConcurrentSync:        f.allowConc,
			WrapperVersion:             Version,
			Logger:                     logger,
			DangerouslySkipPermissions: f.dangerouslySkipPermissions,
		})
		if err != nil {
			fmt.Fprintln(stderr, "clx run:", err)
		}
		return exit
	case "resume":
		// Interactive like `run` — resume opens a TTY session picker.
		exit, err := lifecycle.Run(ctx, lifecycle.Options{
			Config:                     cfg,
			ExtraArgs:                  resumeArgs(subArgs, passthrough),
			SkipBoot:                   f.skipBoot || f.silent,
			Minimal:                    f.minimal,
			AllowConcurrentSync:        f.allowConc,
			WrapperVersion:             Version,
			Logger:                     logger,
			DangerouslySkipPermissions: f.dangerouslySkipPermissions,
		})
		if err != nil {
			fmt.Fprintln(stderr, "clx resume:", err)
		}
		return exit
	case "exec":
		exit, err := claude.Run(ctx, cfg, append(subArgs, passthrough...))
		if err != nil {
			fmt.Fprintln(stderr, "clx exec:", err)
		}
		return exit
	case "execute":
		argv := append([]string{"-p", f.executePrompt}, append(subArgs, passthrough...)...)
		exit, err := lifecycle.Run(ctx, lifecycle.Options{
			Config:                     cfg,
			ExtraArgs:                  argv,
			SkipBoot:                   true,
			Headless:                   true,
			AllowConcurrentSync:        f.allowConc,
			WrapperVersion:             Version,
			Logger:                     logger,
			DangerouslySkipPermissions: f.dangerouslySkipPermissions,
		})
		if err != nil {
			fmt.Fprintln(stderr, "clx execute:", err)
		}
		return exit
	case "status":
		return cmdStatus(ctx, cfg, Version, stdout, stderr, f.minimal)
	case "doctor":
		if err := claude.Doctor(ctx, cfg, stdout, Version); err != nil {
			return 1
		}
		return 0
	case "auth-upload":
		return cmdAuthUpload(ctx, cfg, stdout, stderr)
	case "update":
		theme := ""
		if cfg.EngineOptions.AdminThemeHint != nil {
			theme = *cfg.EngineOptions.AdminThemeHint
		}
		errCaps := ui.DetectCapsFor(stderr, theme)
		artifact, err := resolveWrapperUpdateArtifact(ctx, cfg, Version)
		if err != nil {
			fmt.Fprintln(stderr, ui.UpdateFailure(errCaps, "clx", "wrapper", Version, err))
			return 1
		}
		fmt.Fprintln(stderr, ui.UpdateProgress(errCaps, "clx", "wrapper", Version, artifact.Version))
		cfg.Wrapper.Version = artifact.Version
		cfg.Wrapper.BinaryURL = artifact.URL
		cfg.Wrapper.BinarySHA256 = artifact.SHA256
		if err := update.SelfUpdate(ctx, cfg, logger); err != nil {
			fmt.Fprintln(stderr, ui.UpdateFailure(errCaps, "clx", "wrapper", artifact.Version, err))
			return 1
		}
		fmt.Fprintln(stdout, ui.UpdateComplete(ui.DetectCapsFor(stdout, theme), "clx", "wrapper", artifact.Version, false))
		return 0
	case "uninstall":
		if err := uninstall.Run(ctx, cfg, stdout, stderr); err != nil {
			fmt.Fprintln(stderr, "clx uninstall:", err)
			return 1
		}
		return 0
	case "cron":
		return cmdCron(ctx, cfg, subArgs, stdout, stderr)
	default:
		// Reserved upstream subcommands (login, logout, mcp, …) passthrough to
		// the real claude binary with the token preserved. The wrapper-owned
		// subcommands above win first — `resume` is reserved but never lands
		// here, since its own case claims it; isHelpPassthrough has already
		// caught `--help` variants.
		if reservedClaudeSubcommands[sub] {
			execArgs := append([]string{sub}, append(subArgs, passthrough...)...)
			exit, err := claude.Run(ctx, cfg, execArgs)
			if err != nil {
				fmt.Fprintln(stderr, "clx "+sub+":", err)
			}
			return exit
		}
		fmt.Fprintln(stderr, "clx: unknown subcommand:", sub)
		fmt.Fprintln(stderr, "subcommands: run | resume [<session>] | status | doctor | auth-upload | exec -- <cmd...>")
		fmt.Fprintln(stderr, "flags: --wrapper-help | --version | --status | --doctor | --update | --uninstall | -r/--resume[=<session>] | --continue | --execute <prompt> | --cron [install|remove|run] | --silent | --debug | --minimal | --skip-boot | --dangerously-skip-permissions")
		return 2
	}
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
	if cmp, ok := compareSemver(artifact.Version, current); ok && cmp < 0 {
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
// Help passthrough is detected first so reserved Claude subcommands like
// `clx mcp --help` route straight to the upstream binary without the wrapper
// rejecting any unknown flags.
func parseFlags(args []string) (flags, []string, []string) {
	var f flags
	wrapperHelp := wrapperHelpRequested(args)
	if !wrapperHelp && isHelpPassthrough(args) {
		f.helpPassthrough = true
		return f, nil, nil
	}
	var positional, passthrough []string
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
			_ = os.Setenv("CLAUDE_DEBUG", "1")
		case a == "--minimal" || a == "--minimal-output":
			f.minimal = true
		case a == "--skip-boot" || a == "--no-banner":
			f.skipBoot = true
		case a == "-4" || a == "--ipv4":
			f.forceIPv4 = true
			_ = os.Setenv("CLAUDE_FORCE_IPV4", "1")
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
		case a == "--continue" || a == "-c":
			// Forwarded straight to the upstream `claude` CLI through the
			// normal lifecycle.
			f.continueSession = true
			passthrough = append(passthrough, "--continue")
		case a == "--dangerously-skip-permissions":
			f.dangerouslySkipPermissions = true
			passthrough = append(passthrough, a)
		// Normalised onto the wrapper's `resume` subcommand rather than pushed
		// to passthrough, so `clx resume`, `clx --resume` and `clx -r` all
		// resolve to the same upstream argv. See resumeArgs.
		case a == "--resume" || a == "-r":
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
		case "--resume", "-r", "--cron":
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
	add(f.continueSession, "run", "--continue")
	if !f.resumeFlag && f.executePrompt == "" && !f.executeInvalid && len(positional) > 0 && wrapperOwnedSubcommands[positional[0]] {
		add(true, positional[0], positional[0])
	}
	return actions
}

func cmdStatus(ctx context.Context, cfg *config.Config, wrapperVersion string, stdout, stderr io.Writer, minimal bool) int {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		fmt.Fprintln(stderr, "clx status:", err)
		return 1
	}
	digest, _ := claude.LocalDigest()
	resp, authErr := client.AuthRetrieve(ctx, digest)
	authSynced := false

	// Seed credentials on a fresh install: if the server returns auth and the
	// local status is outdated/missing/updated, write it now so the first
	// `clx run` doesn't hit Claude's interactive login screen.
	if authErr == nil && resp != nil && len(resp.Auth) > 0 {
		switch strings.ToLower(strings.TrimSpace(resp.Status)) {
		case "outdated", "updated", "missing":
			if strings.EqualFold(strings.TrimSpace(resp.VerificationState), "failed") {
				break
			}
			authPath, _ := claude.AuthPath()
			if claude.AuthMatchesCanonical(authPath, resp.Auth) {
				// The server compares the fleet envelope digest, while Claude's
				// native file omits last_refresh. Treat equivalent credentials as
				// current without rewriting or claiming an update.
				resp.Status = "valid"
				break
			}
			if !statusCanonicalAuthMayReplace(authPath, resp.Auth) {
				break
			}
			if err := claude.WriteAuth(resp.Auth); err != nil {
				authErr = fmt.Errorf("apply canonical auth: %w", err)
			} else {
				authSynced = true
			}
		}
	}

	state := summary.Build(ctx, summary.Inputs{
		Config:         cfg,
		WrapperVersion: wrapperVersion,
		Auth:           resp,
		AuthErr:        authErr,
		AuthSynced:     authSynced,
		StatusOnly:     true,
	})
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

// statusCanonicalAuthMayReplace prevents status from clobbering a newer local
// Claude login before the orchestrator has accepted it.
func statusCanonicalAuthMayReplace(localPath string, canonical []byte) bool {
	localTime, err := claude.LastRefreshOfFile(localPath)
	if err != nil {
		return true
	}
	canonicalTime, err := claude.LastRefreshFromRaw(canonical)
	if err != nil {
		return false
	}
	return !localTime.After(canonicalTime)
}

func cmdAuthUpload(ctx context.Context, cfg *config.Config, stdout, stderr io.Writer) int {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	payload, _, err := claude.ReadAuthForUpload()
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	resp, err := client.AuthStore(ctx, payload)
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	if resp != nil && len(resp.Auth) > 0 {
		if err := claude.WriteAuth(resp.Auth); err != nil {
			fmt.Fprintln(stderr, "auth-upload:", err)
			return 1
		}
	}
	fmt.Fprintln(stdout, "auth-upload: ok")
	return 0
}

func cmdCron(ctx context.Context, cfg *config.Config, args []string, stdout, stderr io.Writer) int {
	action := "run"
	if len(args) > 0 {
		action = args[0]
	}
	switch action {
	case "install":
		if err := cron.Install(cfg); err != nil {
			fmt.Fprintln(stderr, "clx --cron install:", err)
			return 1
		}
		fmt.Fprintln(stdout, "cron: installed")
		return 0
	case "remove":
		if err := cron.Remove(); err != nil {
			fmt.Fprintln(stderr, "clx --cron remove:", err)
			return 1
		}
		fmt.Fprintln(stdout, "cron: removed")
		return 0
	case "run":
		res, err := cron.Tick(ctx, cfg)
		if err != nil {
			fmt.Fprintln(stderr, "clx --cron:", err)
			return 1
		}
		fmt.Fprintln(stdout, formatCronResult(res))
		return 0
	default:
		fmt.Fprintln(stderr, "clx cron: unknown action:", action)
		fmt.Fprintln(stderr, "usage: clx cron [install|remove|run]")
		return 2
	}
}

// formatCronResult renders a one-line summary of a cron Tick for human
// consumption — same shape as the cdx side. Keeps `clx --cron` from being
// silent on the common no-op path.
func formatCronResult(r cron.Result) string {
	switch {
	case r.WrapperAction == "disable":
		return "cron: auto-update disabled by server; cron job removed"
	case r.WrapperAction == "updated":
		return fmt.Sprintf("cron: wrapper updated %s → %s (re-exec)", r.WrapperVersion, r.WrapperTarget)
	case r.CodexAction == "updated":
		return fmt.Sprintf("cron: claude updated %s → %s (wrapper %s, reported=%t)", r.CodexBefore, r.CodexVersion, r.WrapperVersion, r.Reported)
	default:
		return fmt.Sprintf("cron: ok (wrapper %s, claude %s, no updates, reported=%t)", r.WrapperVersion, r.CodexVersion, r.Reported)
	}
}

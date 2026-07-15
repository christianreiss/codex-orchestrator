// cdx — Codex Orchestrator wrapper, engine=codex.
//
// Subcommands: run (default), resume, status, doctor, lane, profile, exec,
// auth-upload, --version, --update, --cron [install|remove|run], --uninstall,
// --execute, --resume.
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

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/log"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/signing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ui"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/uninstall"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/update"
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

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
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

func run(args []string, stdout, stderr io.Writer) int {
	// Restart-loop guard: each successful self-update increments
	// CODEX_WRAPPER_RESTART_DEPTH and re-execs us. Cap that at maxRestartDepth
	// so a misbehaving server (or a corrupt local binary that keeps reporting
	// itself out-of-date) cannot fork-bomb our way out of the host.
	depth, _ := strconv.Atoi(os.Getenv("CODEX_WRAPPER_RESTART_DEPTH"))
	if depth > maxRestartDepth {
		fmt.Fprintf(stderr, "cdx: restart depth %d exceeded cap %d — refusing to continue\n", depth, maxRestartDepth)
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
	cron.WrapperVersion = Version

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	f, positional, passthrough := parseFlags(args)
	if actions := conflictingActions(f, positional); len(actions) > 1 {
		fmt.Fprintln(stderr, "cdx: conflicting wrapper actions:", strings.Join(actions, ", "))
		return 2
	}

	if f.wrapperHelp {
		ui.PrintWrapperHelp(stdout, ui.DetectCapsFor(stdout, ""))
		return 0
	}

	// Help passthrough bypasses every wrapper side effect: no lock, no sync,
	// no update check, no boot screen, no footer. argv is unmodified.
	if f.helpPassthrough {
		cli, err := codex.FindCLI()
		if err != nil {
			fmt.Fprintln(stderr, "cdx --help:", err)
			return 127
		}
		execArgv := append([]string{cli}, args...)
		if err := syscall.Exec(cli, execArgv, os.Environ()); err != nil {
			fmt.Fprintln(stderr, "cdx --help: exec failed:", err)
			return 127
		}
		// Unreachable: syscall.Exec replaces this process on success.
		return 0
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

	if f.configPath == "" {
		f.configPath = config.DefaultPath()
	}
	pubkey, _ := signing.PublicKey()
	cfg, err := config.Load(f.configPath, pubkey, false)
	if err != nil {
		sub, _ := resolveCommand(f, positional)
		if sub == "status" {
			fmt.Fprintf(stdout, "cdx | status=blocked | wrapper=%s | config=unreadable\n", ui.CleanInline(Version))
			fmt.Fprintln(stdout, "result | "+ui.CleanInline(err.Error()))
			return 1
		}
		fmt.Fprintln(stderr, err)
		return 2
	}

	// Honour silent flag baked into config too.
	if cfg.EngineOptions.Silent {
		f.silent = true
	}

	logger := log.Setup(f.silent, f.debug)
	sub, subArgs := resolveCommand(f, positional)

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
		if err != nil {
			fmt.Fprintln(stderr, "cdx run:", err)
		}
		return exit
	case "resume":
		// Interactive like `run`, never Headless like `execute` — resume opens
		// a TTY session picker and a headless run would fail it closed.
		exit, err := lifecycle.Run(ctx, lifecycle.Options{
			Config:              cfg,
			ExtraArgs:           resumeArgs(subArgs, passthrough),
			SkipBoot:            f.skipBoot || f.silent,
			Minimal:             f.minimal,
			AllowConcurrentSync: f.allowConc,
			Logger:              logger,
			WrapperVersion:      Version,
		})
		if err != nil {
			fmt.Fprintln(stderr, "cdx resume:", err)
		}
		return exit
	case "exec":
		exit, err := codex.Run(ctx, cfg, append(subArgs, passthrough...))
		if err != nil {
			fmt.Fprintln(stderr, "cdx exec:", err)
		}
		return exit
	case "execute":
		// Headless one-shot via upstream codex exec.
		argv := []string{"--sandbox", "read-only", "-a", "untrusted", "exec", "--skip-git-repo-check", f.executePrompt}
		argv = append(argv, append(subArgs, passthrough...)...)
		exit, err := lifecycle.Run(ctx, lifecycle.Options{
			Config:              cfg,
			ExtraArgs:           argv,
			SkipBoot:            true,
			Headless:            true,
			AllowConcurrentSync: f.allowConc,
			Logger:              logger,
			WrapperVersion:      Version,
		})
		if err != nil {
			fmt.Fprintln(stderr, "cdx execute:", err)
		}
		return exit
	case "status":
		return cmdStatus(ctx, cfg, Version, stdout, stderr, f.minimal)
	case "doctor":
		if err := codex.Doctor(ctx, cfg, stdout, Version); err != nil {
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
		errCaps := ui.DetectCapsFor(stderr, theme)
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
		fmt.Fprintln(stdout, ui.UpdateComplete(ui.DetectCapsFor(stdout, theme), "cdx", "wrapper", artifact.Version, false))
		return 0
	case "uninstall":
		if err := uninstall.Run(ctx, cfg, stdout, stderr); err != nil {
			fmt.Fprintln(stderr, "cdx uninstall:", err)
			return 1
		}
		return 0
	case "cron":
		return cmdCron(ctx, cfg, subArgs, stdout, stderr)
	default:
		// Reserved upstream subcommands (login, logout, mcp, review, …)
		// passthrough to the real codex binary with the token preserved. The
		// wrapper-owned subcommands above win first — `resume` is reserved but
		// never lands here, since its own case claims it; isHelpPassthrough has
		// already caught `--help` variants.
		if reservedCodexSubcommands[sub] {
			// A successful `cdx login` mints the fleet's most precious
			// credential — snapshot the local auth digest so we can detect the
			// rotation and push it to the orchestrator afterwards. Without
			// this the fresh token only ever existed on this disk, and the
			// next sync clobbered it with the stale fleet canonical.
			beforeDigest := ""
			if sub == "login" {
				beforeDigest, _ = codex.LocalDigest()
			}
			execArgs := append([]string{sub}, append(subArgs, passthrough...)...)
			exit, err := codex.Run(ctx, cfg, execArgs)
			if err != nil {
				fmt.Fprintln(stderr, "cdx "+sub+":", err)
			}
			if sub == "login" {
				afterDigest, _ := codex.LocalDigest()
				if loginRotatedAuth(exit, beforeDigest, afterDigest) {
					if code := cmdAuthUpload(ctx, cfg, stdout, stderr); code != 0 {
						fmt.Fprintln(stderr, "cdx login: WARNING — the new credentials were NOT synced to the orchestrator; the fleet still holds the previous token. Retry with `cdx auth-upload`.")
					}
				}
			}
			return exit
		}
		fmt.Fprintln(stderr, "cdx: unknown subcommand:", sub)
		fmt.Fprintln(stderr, "subcommands: run | resume [<session>] | status | doctor | auth-upload | lane <normal|spark|clear> | profile <name> | exec -- <cmd...>")
		fmt.Fprintln(stderr, "flags: --wrapper-help | --version | --status | --doctor | --update | --uninstall | --resume[=<session>] | --execute <prompt> | --cron [install|remove|run] | --silent | --debug | --minimal | --skip-boot | -4 | --allow-concurrent-sync")
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
func cmdStatus(ctx context.Context, cfg *config.Config, wrapperVersion string, stdout, stderr io.Writer, minimal bool) int {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		fmt.Fprintln(stderr, "cdx status:", err)
		return 1
	}
	digest, _ := codex.LocalDigest()
	resp, authErr := client.AuthRetrieve(ctx, digest)
	authSynced := false
	if authErr == nil && resp != nil && len(resp.Auth) > 0 && !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "failed") {
		switch strings.ToLower(strings.TrimSpace(resp.Status)) {
		case "outdated", "updated", "missing":
			authPath, _ := codex.AuthPath()
			if !statusCanonicalAuthMayReplace(authPath, resp.Auth) {
				break
			}
			if err := codex.WriteAuth(resp.Auth); err != nil {
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

// statusCanonicalAuthMayReplace prevents a read-only-looking status check from
// destroying a newer local login when the fleet has not adopted it yet. An
// absent/unreadable local file may be repaired; an existing local file wins
// over a canonical payload with no usable freshness stamp.
func statusCanonicalAuthMayReplace(localPath string, canonical []byte) bool {
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

// cmdAuthUpload pushes a locally-edited auth.json to the orchestrator.
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
	payload, err := codex.ReadAuth()
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	// Legacy parity: a vanilla `codex login` auth.json has no `last_refresh`
	// and the orchestrator would reject the POST. Backfill an RFC3339 stamp
	// in-memory so the upload goes through; the server's canonical store
	// rewrites `last_refresh` to its own clock anyway.
	payload, backfilled, err := codex.BackfillLastRefresh(payload)
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	if err := client.AuthStore(ctx, payload); err != nil {
		fmt.Fprintln(stderr, "auth-upload:", err)
		return 1
	}
	if backfilled {
		fmt.Fprintln(stdout, "auth-upload: ok (last_refresh backfilled)")
	} else {
		fmt.Fprintln(stdout, "auth-upload: ok")
	}
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
			fmt.Fprintln(stderr, "cdx --cron install:", err)
			return 1
		}
		fmt.Fprintln(stdout, "cron: installed")
		return 0
	case "remove":
		if err := cron.Remove(); err != nil {
			fmt.Fprintln(stderr, "cdx --cron remove:", err)
			return 1
		}
		fmt.Fprintln(stdout, "cron: removed")
		return 0
	case "run":
		// Non-interactive auto-update tick.
		res, err := cron.Tick(ctx, cfg)
		if err != nil {
			fmt.Fprintln(stderr, "cdx --cron:", err)
			return 1
		}
		fmt.Fprintln(stdout, formatCronResult(res))
		return 0
	default:
		fmt.Fprintln(stderr, "cdx cron: unknown action:", action)
		fmt.Fprintln(stderr, "usage: cdx cron [install|remove|run]")
		return 2
	}
}

// formatCronResult renders a one-line summary of a cron Tick for human
// consumption. The current invocation either updated something, kept things
// as-is, or saw the server disable cron entirely; the line states which and
// names the versions involved so `cdx --cron` is never silent on success.
func formatCronResult(r cron.Result) string {
	switch {
	case r.WrapperAction == "disable":
		return "cron: auto-update disabled by server; cron job removed"
	case r.WrapperAction == "updated":
		return fmt.Sprintf("cron: wrapper updated %s → %s (re-exec)", r.WrapperVersion, r.WrapperTarget)
	case r.CodexAction == "updated":
		return fmt.Sprintf("cron: codex updated %s → %s (wrapper %s, reported=%t)", r.CodexBefore, r.CodexVersion, r.WrapperVersion, r.Reported)
	default:
		return fmt.Sprintf("cron: ok (wrapper %s, codex %s, no updates, reported=%t)", r.WrapperVersion, r.CodexVersion, r.Reported)
	}
}

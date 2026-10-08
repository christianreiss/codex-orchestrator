// Package grok implements the cgx persona of the shared cxx executable.
package grok

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	hostcron "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	hostmaintenance "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/maintenance"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/quotaadvice"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/schedulewatch"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
	shareduninstall "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/uninstall"
	coreupdate "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
)

var Version, Commit, BuildDate = "dev", "unknown", "unknown"
var HostSyncAfterUpdate bool
var requestHostMaintenance = hostmaintenance.Request

type options struct {
	configPath                        string
	skipBoot, concurrent, debug, ipv4 bool
	minimal                           bool
	command                           string
	args                              []string
}

func parse(args []string) (options, error) {
	path, err := config.DefaultPathForEngine(config.EngineGrok)
	if err != nil {
		return options{}, err
	}
	o := options{configPath: path, command: "run"}
	for len(args) > 0 {
		arg := args[0]
		args = args[1:]
		switch arg {
		case "--config":
			if len(args) == 0 {
				return o, errors.New("--config requires a file")
			}
			o.configPath, args = args[0], args[1:]
		case "--skip-boot", "--minimal-output", "--silent", "--no-banner":
			o.skipBoot = true
			if arg == "--minimal-output" {
				o.minimal = true
			}
		case "--allow-concurrent-sync":
			o.concurrent = true
		case "-4":
			o.ipv4 = true
		case "--verbose", "--debug":
			o.debug = true
		case "--wrapper-version", "-W":
			o.command = "version"
			return o, nil
		case "--wrapper-help":
			o.command = "help"
			return o, nil
		case "--update", "-U":
			o.command = "update"
			o.args = args
			return o, nil
		case "--uninstall":
			o.command = "uninstall"
			o.args = args
			return o, nil
		case "--status":
			args = append([]string{"status"}, args...)
		case "--doctor":
			args = append([]string{"doctor"}, args...)
		case "--cron":
			o.command = "cron"
			o.args = args
			return o, nil
		case "--execute":
			if len(args) == 0 {
				return o, errors.New("--execute requires a prompt")
			}
			o.command = "execute"
			o.args = args
			return o, nil
		case "run":
			o.args = args
			return o, nil
		case "resume":
			o.args = append([]string{"--resume"}, args...)
			return o, nil
		case "sync", "status", "doctor", "update", "uninstall", "cron", "login", "logout", "auth-sync", "auth-upload-auto", "help":
			o.command = arg
			if arg == "sync" || arg == "cron" || arg == "status" || arg == "doctor" {
				for _, value := range args {
					if hasArg([]string{value}, "--minimal", "--minimal-output", "--silent", "--skip-boot", "--no-banner") {
						if value == "--minimal" || value == "--minimal-output" {
							o.minimal = true
						}
						o.skipBoot = true
						continue
					}
					if value == "--allow-concurrent-sync" {
						o.concurrent = true
						continue
					}
					o.args = append(o.args, value)
				}
			} else {
				o.args = args
			}
			return o, nil
		default:
			o.args = append([]string{arg}, args...)
			return o, nil
		}
	}
	return o, nil
}

func RunWithChoice(args []string, stdout, stderr io.Writer, _ *quotaadvice.Session) int {
	return Run(args, stdout, stderr)
}
func Run(args []string, stdout, stderr io.Writer) int {
	o, err := parse(args)
	if err != nil {
		fmt.Fprintln(stderr, "cgx:", err)
		return 2
	}
	return runOptions(o, stdout, stderr)
}

// RunNative preserves the native CLI grammar while retaining fleet account
// ownership and the same session/receiver lifecycle as cgx.
func RunNative(args []string, stdout, stderr io.Writer) int {
	o, err := nativeOptions(args)
	if err != nil {
		fmt.Fprintln(stderr, "grok:", err)
		return 1
	}
	return runOptions(o, stdout, stderr)
}

func nativeOptions(args []string) (options, error) {
	path, err := config.DefaultPathForEngine(config.EngineGrok)
	if err != nil {
		return options{}, err
	}
	o := options{configPath: path, command: "run", args: append([]string(nil), args...), skipBoot: true}
	if len(args) > 0 && (args[0] == "update" || args[0] == "upgrade" || args[0] == "install") && !isHelpPassthrough(args) {
		return options{}, errors.New("Grok installation is fleet-managed; use cgx update")
	}
	// Subscription login is centrally owned even through the native name.
	if len(args) > 0 && (args[0] == "login" || args[0] == "logout") && !isHelpPassthrough(args) {
		o.command, o.args = args[0], append([]string(nil), args[1:]...)
	}
	return o, nil
}

func runOptions(o options, stdout, stderr io.Writer) int {
	var err error
	if o.command == "version" {
		terminalui.PrintVersion(stdout, terminalui.BuildInfo{Name: "cgx", Version: Version, Commit: Commit, BuildDate: BuildDate, SigningKey: signing.HasKey()})
		return 0
	}
	if o.command == "help" {
		PrintWrapperHelp(stdout, terminalui.DetectCapsFor(stdout, "auto"))
		return 0
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if o.command == "run" && len(o.args) > 0 && (o.args[0] == "--version" || o.args[0] == "-v" || isHelpPassthrough(o.args)) {
		path, err := native.FindCLI()
		if err != nil {
			fmt.Fprintln(stderr, "cgx:", err)
			return 1
		}
		return execute(ctx, path, o.args, native.NativeEnv(os.Environ()), stdout, stderr)
	}
	cfg, err := load(ctx, o.configPath)
	if err != nil {
		fmt.Fprintln(stderr, "cgx:", err)
		return 1
	}
	if cfg.EngineOptions.GrokModelOverride != nil {
		cfg.EngineOptions.ModelOverride = cfg.EngineOptions.GrokModelOverride
	}
	if cfg.EngineOptions.GrokReasoningEffortOverride != nil {
		cfg.EngineOptions.ReasoningEffortOverride = cfg.EngineOptions.GrokReasoningEffortOverride
	}
	o.skipBoot = o.skipBoot || cfg.EngineOptions.Silent
	client, err := newClient(cfg, o.ipv4)
	if err != nil {
		fmt.Fprintln(stderr, "cgx: orchestrator connection unavailable")
		return 1
	}
	logger := slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	if o.debug {
		logger = slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}
	client.Logger = logger
	switch o.command {
	case "run", "execute", "sync", "auth-sync", "login":
		// A cloned or mis-deployed host refuses before it syncs or leases.
		if err := native.GuardFQDN(cfg); err != nil {
			fmt.Fprintln(stderr, "cgx:", err)
			return 1
		}
	}
	queueHostMaintenance(o.command, cfg, logger)
	switch o.command {
	case "auth-upload-auto":
		return 0 // Managed runtimes intentionally have no canonical refresh token.
	case "login":
		err = login(ctx, cfg, client, o.args, stdout, stderr)
	case "logout":
		err = clearPendingLogin()
	case "update":
		err = maintenance(ctx, cfg, client, true, stdout, stderr)
	case "cron":
		return cronCommand(ctx, cfg, client, o, stdout, stderr)
	case "uninstall":
		err = uninstall(ctx, cfg, client, stdout, stderr)
	case "sync", "auth-sync":
		err = syncManaged(ctx, cfg, client)
	case "status", "doctor":
		err = status(ctx, cfg, client, o.command == "doctor", o, stdout)
	default:
		code, runErr := run(ctx, cfg, client, o, stdout, stderr)
		if runErr != nil {
			fmt.Fprintln(stderr, "cgx:", runErr)
		}
		return code
	}
	if err != nil {
		fmt.Fprintln(stderr, "cgx:", err)
		return 1
	}
	return 0
}

func queueHostMaintenance(command string, cfg *config.Config, logger *slog.Logger) {
	switch command {
	case "run", "execute", "sync", "auth-sync", "status", "doctor":
		if err := requestHostMaintenance(config.EngineGrok, cfg.SourcePath()); err != nil {
			logger.Debug("background maintenance request deferred", "err", err)
		}
	}
}

func PrintWrapperHelp(w io.Writer, caps terminalui.Caps) {
	terminalui.PrintWrapperHelp(w, caps, "cgx", "Grok", []terminalui.HelpItem{
		{Usage: "run [native arguments]", Description: "Launch Grok with a leased subscription account and an isolated managed runtime."},
		{Usage: "resume [UUID or title]", Description: "Resume native history; --continue resumes the latest session."},
		{Usage: "sync", Description: "Merge fleet settings, instructions, skills access, and MCP into the native home."},
		{Usage: "status | doctor", Description: "Show native installation and subscription authentication health."},
		{Usage: "login", Description: "Log in through native subscription OAuth, upload to the central owner, and erase temporary credentials."},
		{Usage: "login retry | logout", Description: "Retry an unaccepted protected login within 24 hours, or erase pending login material."},
		{Usage: "update | cron run", Description: "Verify and install the selected native package and shared wrapper."},
		{Usage: "uninstall", Description: "Remove cgx and its managed state while preserving native history and unwrapped credentials."},
	}, []terminalui.HelpItem{
		{Usage: "-W, --wrapper-version", Description: "Print this wrapper's version."},
		{Usage: "--config FILE", Description: "Use a signed Grok host configuration."},
		{Usage: "--skip-boot", Description: "Suppress the wrapper's banner and footer."},
		{Usage: "--allow-concurrent-sync", Description: "Continue when another cgx lifecycle holds the content sync lock."},
		{Usage: "--execute PROMPT", Description: "Send one protected-file prompt and return native JSON."},
		{Usage: "-4", Description: "Prefer IPv4 for orchestrator connections."},
	})
}

func load(ctx context.Context, path string) (*config.Config, error) {
	key, err := signing.PublicKey()
	if err != nil {
		return nil, err
	}
	cfg, err := config.LoadForEngine(path, key, false, config.EngineGrok)
	var expired *config.ExpiredError
	if errors.As(err, &expired) && expired.Config != nil {
		fetched, fetchErr := fleetconfig.Fetch(ctx, expired.Config, config.EngineGrok)
		if fetchErr != nil {
			return nil, fetchErr
		}
		if err := fleetconfig.PersistTo(ctx, path, fetched); err != nil {
			return nil, err
		}
		return config.LoadForEngine(path, key, false, config.EngineGrok)
	}
	return cfg, err
}
func newClient(cfg *config.Config, forceIPv4 ...bool) (*orchestrator.Client, error) {
	ca := ""
	if cfg.Orchestrator.CABundlePath != nil {
		ca = *cfg.Orchestrator.CABundlePath
	}
	client, err := orchestrator.New(orchestrator.Options{BaseURL: cfg.Orchestrator.BaseURL, APIKey: cfg.Orchestrator.APIKey, CABundlePath: ca, AllowInsecure: cfg.Orchestrator.AllowInsecure})
	if client != nil {
		if len(forceIPv4) > 0 && forceIPv4[0] {
			if transport, ok := client.HTTP.Transport.(*http.Transport); ok {
				dialer := &net.Dialer{Timeout: 30 * time.Second}
				transport.DialContext = func(ctx context.Context, _, address string) (net.Conn, error) {
					return dialer.DialContext(ctx, "tcp4", address)
				}
			}
		}
		client.UserAgent = "cgx/wrapper-v2"
		home, err := native.Home()
		if err != nil {
			return nil, err
		}
		client.Pool = accountpool.Load(config.EngineGrok, filepath.Join(home, "auth.json"), cfg.Orchestrator.BaseURL)
	}
	return client, err
}

func syncManaged(ctx context.Context, cfg *config.Config, client *orchestrator.Client) error {
	_, err := syncMeasuredManaged(ctx, cfg, client)
	return err
}

func syncMeasuredManaged(ctx context.Context, cfg *config.Config, client *orchestrator.Client) (managedSyncSummary, error) {
	return syncMeasuredManagedWith(ctx, cfg, client, false)
}

// syncMeasuredManagedWith converges instructions, config, native skills and
// peer engines. unlocked mirrors cdx --allow-concurrent-sync: the operator
// explicitly accepts writing while another cgx lifecycle holds the lock.
func syncMeasuredManagedWith(ctx context.Context, cfg *config.Config, client *orchestrator.Client, unlocked bool) (summary managedSyncSummary, syncErr error) {
	if !unlocked {
		lock, err := ipc.TryAcquireExclusive("cgx-sync")
		if err != nil {
			return summary, fmt.Errorf("managed Grok sync lock: %w", err)
		}
		defer lock.Release()
	}
	home, err := native.Home()
	if err != nil {
		return summary, err
	}
	store, err := native.Skills()
	if err != nil {
		return summary, err
	}
	bundle, err := client.SyncBootstrap(ctx, orchestrator.BundleRequest{Engine: "grok", IncludeAuth: false, Home: home, Skills: store.Digests()})
	if err != nil {
		if scope, disabled := orchestrator.EngineDisabledScope(err); disabled {
			return summary, errors.New(config.EngineDisabledMessage(config.EngineGrok, scope))
		}
		return summary, fmt.Errorf("Grok managed sync unavailable: %w", err)
	}
	summary.Sessions = bundle.Sessions
	// SyncBootstrap already unwraps resource objects to document bytes.
	if body := bundle.Agents; len(body) > 0 {
		digest := sha256.Sum256(body)
		if documentDigest(filepath.Join(home, "AGENTS.md")) != hex.EncodeToString(digest[:]) {
			if err := native.AtomicWrite(filepath.Join(home, "AGENTS.md"), body, 0o600); err != nil {
				return summary, err
			}
			summary.Config.Updated = true
		}
		state, err := native.StateDir()
		if err != nil {
			return summary, err
		}
		if err := native.AtomicWrite(filepath.Join(state, "managed-agents.sha256"), []byte(hex.EncodeToString(digest[:])), 0o600); err != nil {
			return summary, err
		}
	}
	if body := bundle.Config; len(body) > 0 || bundle.ConfigOwnedPaths != nil {
		path := filepath.Join(home, "config.toml")
		before := documentDigest(path)
		if err := native.SyncConfig(home, body, bundle.ConfigOwnedPaths); err != nil {
			return summary, err
		}
		summary.Config.Checked = true
		summary.Config.Updated = summary.Config.Updated || before != documentDigest(path)
	}
	// Grok loads ~/.grok/skills natively. Skill failures warn like cdx/clx:
	// they never block a launch or a content sync.
	if bundle.GrokSkills != nil {
		updated, err := store.Apply(bundle.GrokSkills)
		summary.Skills = resourceSync{Checked: err == nil, Updated: updated, Failed: err != nil}
		if err != nil {
			warn(client, "native Grok skills sync incomplete", err)
		}
	} else {
		// An older server sends no bundle; prove the MCP listing is reachable.
		var skills map[string]any
		if err := client.JSON(ctx, http.MethodGet, "/skills?engine=grok", nil, &skills, 0); err != nil {
			summary.Skills.Failed = true
			warn(client, "Grok skills listing unavailable", err)
		} else {
			summary.Skills.Checked = true
		}
	}
	username := os.Getenv("USER")
	if current, err := user.Current(); err == nil {
		username = current.Username
	}
	hostname, _ := os.Hostname()
	if username != "" {
		_ = client.JSON(ctx, http.MethodPost, "/host/users", map[string]any{"username": username, "hostname": hostname}, nil, 0)
	}
	if err := reconcilePeers(ctx, cfg); err != nil {
		warn(client, "peer engine reconcile incomplete", err)
	}
	return summary, nil
}

func warn(client *orchestrator.Client, message string, err error) {
	if client != nil && client.Logger != nil {
		client.Logger.Warn(message, "err", err)
	}
}

func documentDigest(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}
func merge(dst, src map[string]any) {
	for key, value := range src {
		if child, ok := value.(map[string]any); ok {
			target, _ := dst[key].(map[string]any)
			if target == nil {
				target = map[string]any{}
			}
			merge(target, child)
			dst[key] = target
		} else {
			dst[key] = value
		}
	}
}

func reconcilePeers(ctx context.Context, cfg *config.Config) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	engines := config.EnabledEngines(cfg.Host, cfg.Engine)
	var errs error
	for _, engine := range engines {
		if engine == cfg.Engine {
			continue
		}
		item, err := fleetconfig.Fetch(ctx, cfg, engine)
		if errors.Is(err, fleetconfig.ErrEngineDisabled) {
			continue
		}
		if err == nil {
			err = fleetconfig.Persist(ctx, item)
		}
		if err != nil {
			errs = errors.Join(errs, fmt.Errorf("%s config: %w", engine, err))
		}
	}
	_, err = layout.EnsureAliases(ctx, exe, engines)
	return errors.Join(errs, err)
}

func run(ctx context.Context, cfg *config.Config, client *orchestrator.Client, o options, stdout, stderr io.Writer) (exitCode int, runErr error) {
	headless := o.command == "execute" || nativeAnyFlag(o.args, "-p", "--single", "--print", "--prompt-file", "--prompt-json") || len(o.args) > 0 && o.args[0] == "agent"
	// Like cdx: another lifecycle holding the sync lock pauses managed content
	// writes for this launch; auth freshness and the lease remain active.
	sync, syncErr := syncMeasuredManagedWith(ctx, cfg, client, o.concurrent)
	if syncErr != nil {
		if !errors.Is(syncErr, ipc.ErrHeld) {
			if refusal := launchRefusal(cfg, syncErr); refusal != nil {
				return 1, refusal
			}
			return 1, syncErr
		}
		sync = managedSyncSummary{Concurrent: true}
	}
	baseHome, err := native.Home()
	if err != nil {
		return 1, err
	}
	pool := accountpool.Load("grok", filepath.Join(baseHome, "auth.json"), cfg.Orchestrator.BaseURL)
	client.Pool = pool
	initial, err := retrieveStartupAuth(ctx, client, headless, o.minimal, stderr)
	if err != nil {
		if refusal := launchRefusal(cfg, err); refusal != nil {
			return 1, refusal
		}
		var httpErr *orchestrator.HTTPError
		if errors.As(err, &httpErr) {
			return 1, fmt.Errorf("Grok subscription auth unavailable (%s); run cgx login", httpErr.Code)
		}
		return 1, err
	}
	// Server-side kill switch, as cdx/clx enforce it from the same block.
	if initial.Versions != nil && initial.Versions.APIDisabled {
		return 1, errors.New(apiDisabledReason)
	}
	reconcileEngineDrift(cfg, initial, client)
	if _, err := native.FindCLI(); err != nil {
		// First launch on a host whose installer or cron has not yet placed the
		// native CLI: install the fleet's verified target in the foreground.
		target := native.PinnedVersion
		if v := initial.Versions; v != nil {
			for _, candidate := range []string{stringValue(v.ClientVersionOverride), stringValue(v.ClientVersion)} {
				if candidate != "" && candidate != "latest" {
					target = candidate
					break
				}
			}
		}
		if !o.skipBoot {
			terminalui.Say(stderr, "cgx", terminalui.ToneDim, "install", "installing Grok "+target)
		}
		if _, err := native.Install(ctx, target); err != nil {
			return 1, fmt.Errorf("Grok CLI install failed: %w", err)
		}
	}
	if !pool.Capable {
		return 1, errors.New("Grok requires centralized account leases")
	}
	var started time.Time
	version, cleanupOK, minimal := "", false, o.minimal
	// This defer runs after lease release and private-home cleanup, so the
	// displayed footer uses the final outcome rather than a provisional exit.
	defer func() {
		if o.skipBoot || started.IsZero() {
			return
		}
		caps := terminalui.DetectCapsFor(stderr, stringValue(cfg.EngineOptions.AdminThemeHint))
		if minimal {
			caps.IsTTY = false
		}
		authStatus, authTone := "access-only runtime removed", terminalui.ToneDim
		if !cleanupOK {
			authStatus, authTone = "private runtime cleanup failed", terminalui.ToneFail
		}
		terminalui.PrintExitFooter(stderr, caps, "cgx", terminalui.ExitFooter{RunDuration: time.Since(started), ExitCode: exitCode, AuthStatus: authStatus, AuthTone: authTone, EngineName: "grok", EngineVersion: version})
	}()
	rt, err := native.NewRuntime(baseHome, cfg, client, pool)
	if err != nil {
		return 1, err
	}
	defer func() {
		if err := rt.Close(); err != nil {
			exitCode = 1
			runErr = errors.New("Grok private runtime cleanup failed")
		} else {
			cleanupOK = true
		}
	}()
	release, lease, err := pool.Start(ctx, client, false, func(raw json.RawMessage, _ string, _ bool) (bool, error) {
		err := rt.Apply(raw, 0)
		return err == nil, err
	})
	if err != nil {
		return 1, err
	}
	defer release()
	if lease == nil {
		return 1, errors.New("Grok account lease unavailable")
	}
	if err := rt.Initialize(ctx); err != nil {
		return 1, errors.New("Grok leased credentials unavailable")
	}
	initial = leasedStartupAuth(initial, lease)
	if err := rt.StartAuthBroker(ctx); err != nil {
		return 1, err
	}
	restorePool := pool.ActivateEnvironment()
	defer restorePool()
	args := append([]string(nil), o.args...)
	if o.command == "execute" {
		f, err := os.CreateTemp(rt.Dir, "prompt-*.txt")
		if err != nil {
			return 1, err
		}
		if _, err := f.WriteString(strings.Join(o.args, " ")); err != nil {
			f.Close()
			return 1, err
		}
		f.Close()
		args = []string{"--prompt-file", f.Name(), "--output-format", "json"}
	}
	connection, portalErr := agentportal.StartConnection(ctx, cfg, agentportal.StartInput{Engine: "grok", InvocationKind: map[bool]string{true: "execute", false: "interactive"}[headless], Resumed: nativeAnyFlag(args, "--resume", "--continue", "-r", "-c"), UpstreamSessionID: agentportal.ExplicitResumeSessionID(args)})
	if portalErr != nil {
		fmt.Fprintln(stderr, "cgx: agent portal temporarily unavailable")
	}
	ctx = connection.Context()
	defer func() {
		state, summary := "completed", "Grok session ended"
		if runErr != nil || exitCode != 0 {
			state, summary = "failed", "Grok session failed"
		}
		if err := connection.Close(state, summary); err != nil {
			fmt.Fprintln(stderr, "cgx: agent portal cleanup failed")
		}
	}()
	exe, err := os.Executable()
	if err != nil {
		return 1, err
	}
	if err := rt.Configure(exe, cfg, connection.Session() != nil); err != nil {
		return 1, err
	}
	path, err := native.FindCLI()
	if err != nil {
		return 1, err
	}
	env := rt.Environment(os.Environ())
	sessionCtx, stop := context.WithCancel(ctx)
	refreshDone := make(chan struct{})
	authFailure := make(chan error, 1)
	defer func() { stop(); <-refreshDone }()
	go func() {
		defer close(refreshDone)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-sessionCtx.Done():
				return
			case <-ticker.C:
				callCtx, cancel := context.WithTimeout(sessionCtx, 6*time.Second)
				err := rt.Refresh(callCtx)
				cancel()
				if native.FatalAuthError(err) {
					select {
					case authFailure <- errors.New("Grok account lease or subscription auth ended; resume through cgx after login"):
					default:
					}
					stop()
					return
				}
			}
		}
	}()
	if !headless && !nativeAnyFlag(args, "--no-leader", "--leader-socket") {
		socket := filepath.Join(rt.Dir, "grok.sock")
		env = native.SetEnv(env, "CXX_GROK_SOCKET", socket)
		leader := exec.CommandContext(sessionCtx, path, "agent", "leader", "--leader-socket", socket, "--relay-on-demand", "--no-auto-update")
		leader.Env = env
		leader.Stdout = io.Discard
		leader.Stderr = stderr
		closeLease, err := rt.AttachChild(leader)
		if err != nil {
			return 1, err
		}
		startErr := leader.Start()
		closeLease()
		if startErr != nil {
			return 1, errors.New("Grok private leader failed to start")
		}
		defer func() { stop(); _ = leader.Wait() }()
		deadline := time.Now().Add(20 * time.Second)
		for {
			if _, err := os.Stat(socket); err == nil {
				break
			}
			if time.Now().After(deadline) {
				return 1, errors.New("Grok private leader startup timed out")
			}
			select {
			case <-ctx.Done():
				return 1, ctx.Err()
			case <-time.After(40 * time.Millisecond):
			}
		}
		args = append([]string{"--leader", "--leader-socket", socket}, args...)
	} else if headless && !nativeAnyFlag(args, "--no-leader", "--leader-socket", "--leader") {
		args = append([]string{"--no-leader"}, args...)
	}
	args = interactiveArgs(args, headless, o.skipBoot)
	minimal = o.minimal || nativeFlag(args, "--minimal")
	var versionErr error
	version, versionErr = native.ProbeVersion(ctx, path)
	if !o.skipBoot {
		terminalui.PrintBootScreen(stderr, startupScreen(startupInput{Config: cfg, Auth: &initial, EngineVersion: version, VersionErr: versionErr, WrapperVersion: Version, Home: rt.Home, EffectiveHome: true, LaunchArgs: args, Sync: sync, Minimal: minimal}))
	}
	started = time.Now()
	code := execute(sessionCtx, path, args, env, stdout, stderr, rt)
	select {
	case err := <-authFailure:
		return 1, err
	default:
	}
	return code, nil
}
func nativeAnyFlag(args []string, names ...string) bool {
	for _, name := range names {
		if nativeFlag(args, name) {
			return true
		}
	}
	return false
}

func hasArg(args []string, names ...string) bool {
	for _, arg := range args {
		for _, name := range names {
			if arg == name || strings.HasPrefix(arg, name+"=") {
				return true
			}
		}
	}
	return false
}
func execute(ctx context.Context, path string, args, env []string, stdout, stderr io.Writer, runtimes ...*native.Runtime) int {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = env
	cmd.Stdin = os.Stdin
	cmd.Stdout = schedulewatch.Writer(ctx, stdout)
	cmd.Stderr = schedulewatch.Writer(ctx, stderr)
	closeLease := func() {}
	if len(runtimes) > 0 {
		var err error
		closeLease, err = runtimes[0].AttachChild(cmd)
		if err != nil {
			fmt.Fprintln(stderr, "cgx: native activity lease unavailable")
			return 1
		}
	}
	err := cmd.Start()
	closeLease()
	if err == nil {
		stopWatch := schedulewatch.Start(ctx, cmd)
		err = cmd.Wait()
		stopWatch()
	}
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	fmt.Fprintln(stderr, "cgx: native Grok failed to start")
	return 1
}

func status(ctx context.Context, cfg *config.Config, client *orchestrator.Client, doctor bool, o options, stdout io.Writer) error {
	path, findErr := native.FindCLI()
	version := ""
	if findErr == nil {
		version, findErr = native.ProbeVersion(ctx, path)
	}
	var auth startupAuth
	started := time.Now()
	err := client.JSON(ctx, http.MethodPost, "/auth", map[string]any{"engine": "grok", "command": "retrieve"}, &auth, 0)
	latency := time.Since(started)
	home, _ := native.Home()
	screen := startupScreen(startupInput{Config: cfg, Auth: &auth, AuthErr: err, EngineVersion: version, VersionErr: findErr, WrapperVersion: Version, Home: home, StatusOnly: true, Minimal: o.minimal})
	terminalui.PrintBootScreen(stdout, screen)
	if doctor {
		report := doctorReport(doctorInput{Config: cfg, Home: home, CLIPath: path, EngineVersion: version, VersionErr: findErr, Auth: &auth, AuthErr: err, Latency: latency})
		caps := terminalui.DetectCapsFor(stdout, stringValue(cfg.EngineOptions.AdminThemeHint))
		if o.minimal {
			caps = terminalui.MinimalCaps(caps)
		}
		terminalui.PrintDoctor(stdout, caps, report)
		if screen.ResultTone == terminalui.ToneFail || report.Result.Tone == terminalui.ToneFail {
			return errors.New("Grok doctor checks failed")
		}
		return nil
	}
	if screen.ResultTone == terminalui.ToneFail {
		return errors.New("Grok status checks failed")
	}
	return nil
}

// maintenance is the cron tick (force=false) and `cgx update` (force=true):
// wrapper self-update, native CLI convergence, shell alias, content sync and
// a version report that is sent even when the content sync fails.
func maintenance(ctx context.Context, cfg *config.Config, client *orchestrator.Client, force bool, stdout, stderr io.Writer) error {
	path, _ := native.FindCLI()
	before := ""
	if path != "" {
		before, _ = native.ProbeVersion(ctx, path)
	}
	check, err := client.CronCheck(ctx, orchestrator.CronCheckRequest{Engine: "grok", ClientVersion: before, WrapperVersion: Version})
	if err != nil {
		return err
	}
	if check.Action != "disable" && check.Wrapper != nil && check.Wrapper.Action == "update" {
		if os.Getenv(wrapperRestartedEnv) == "1" {
			return fmt.Errorf("wrapper update loop detected for target %s", check.Wrapper.TargetVersion)
		}
		if check.Wrapper.URL == "" || check.Wrapper.SHA256 == "" || check.Wrapper.TargetVersion == "" {
			return errors.New("wrapper update requested but metadata incomplete")
		}
		if semverVersion.MatchString(Version) && !codex.SemverGT(check.Wrapper.TargetVersion, Version) {
			warn(client, "skipping wrapper downgrade to "+check.Wrapper.TargetVersion+" from "+Version, nil)
		} else {
			installed, err := coreupdate.Install(ctx, cfg, check.Wrapper.URL, check.Wrapper.SHA256, check.Wrapper.TargetVersion, client.Logger)
			if err != nil {
				return err
			}
			// Re-run the same command on the new binary so it also converges the
			// native CLI; the marker stops a server that keeps offering a binary
			// which does not report the offered version.
			engine, args := "grok", []string{"cron", "run"}
			if force {
				args = []string{"update"}
			}
			if HostSyncAfterUpdate {
				engine, args = "", []string{"sync"}
			}
			return syscall.Exec(installed, layout.ReexecArgv(installed, engine, args), append(os.Environ(), wrapperRestartedEnv+"=1"))
		}
	}
	target := check.TargetVersion
	if target == "" {
		target = native.PinnedVersion
	}
	version := before
	cliUpdated := false
	if path == "" || (check.Action != "disable" && (check.Action == "update" || (force && before != target))) {
		path, err = native.Install(ctx, target)
		if err != nil {
			return err
		}
		version, err = native.ProbeVersion(ctx, path)
		if err != nil {
			return err
		}
		cliUpdated = version != before
	}
	if err := native.EnsureShellAliases(); err != nil {
		warn(client, "shell alias", err)
	}
	syncErr := syncManaged(ctx, cfg, client)
	if errors.Is(syncErr, ipc.ErrHeld) {
		syncErr = errors.New("managed sync paused by an active session; retry when it finishes or use --allow-concurrent-sync")
	}
	if !hostcron.IsCoordinated() {
		if err := hostcron.Install(ctx, cfg); err != nil {
			syncErr = errors.Join(syncErr, err)
		}
	}
	_ = native.Prune()
	var reportErr error
	reported := false
	for attempt := 1; attempt <= 2; attempt++ {
		if reportErr = client.CronReport(ctx, orchestrator.CronReportRequest{Engine: "grok", ClientVersion: version, WrapperVersion: Version}); reportErr == nil {
			reported = true
			break
		}
		if attempt < 2 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
			}
		}
	}
	label := "cron"
	if force {
		label = "update"
	}
	switch {
	case cliUpdated && before != "":
		fmt.Fprintf(stdout, "%s: grok updated %s -> %s (wrapper %s, reported=%t)\n", label, before, version, Version, reported)
	case cliUpdated:
		fmt.Fprintf(stdout, "%s: grok installed %s (wrapper %s, reported=%t)\n", label, version, Version, reported)
	default:
		fmt.Fprintf(stdout, "%s: ok (wrapper %s, grok %s, no updates, reported=%t)\n", label, Version, version, reported)
	}
	if syncErr != nil {
		fmt.Fprintln(stderr, "cgx "+label+": managed content sync failed:", syncErr)
	}
	if reportErr != nil {
		reportErr = fmt.Errorf("/cron/report failed after retry: %w", reportErr)
	}
	return errors.Join(syncErr, reportErr)
}

const wrapperRestartedEnv = "CGX_WRAPPER_RESTARTED"

var semverVersion = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+`)

func loginConflictMetadata(raw []byte) (int64, int64) {
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return 0, 0
	}
	var find func(map[string]any) (int64, int64)
	find = func(node map[string]any) (int64, int64) {
		id, _ := node["account_id"].(float64)
		generation, _ := node["canonical_generation"].(float64)
		if id > 0 && generation > 0 {
			return int64(id), int64(generation)
		}
		for _, key := range []string{"error", "errors", "details", "data"} {
			if nested, ok := node[key].(map[string]any); ok {
				if id, generation := find(nested); id > 0 {
					return id, generation
				}
			}
		}
		return 0, 0
	}
	return find(doc)
}
func uninstall(ctx context.Context, cfg *config.Config, client *orchestrator.Client, stdout, stderr io.Writer) error {
	home, err := native.Home()
	if err != nil {
		return err
	}
	guard, err := native.TryAcquireMaintenance(home)
	if err != nil {
		if errors.Is(err, ipc.ErrHeld) {
			return errors.New("uninstall refused: another cgx process is using this Grok home")
		}
		return err
	}
	defer guard.Release()
	// Shared aliases, cxx and cron belong to every user of the host. Refuse a
	// multi-user host unless this process can act for all of them, failing
	// closed when the registry cannot be asked (cdx/clx semantics).
	others, othersErr := otherHostUsers(ctx, client)
	if othersErr != nil || len(others) > 0 {
		reason := fmt.Sprintf("host has registered users besides this one (%v)", others)
		if othersErr != nil {
			reason = "the multi-user safety check could not run"
		}
		if os.Geteuid() != 0 && exec.CommandContext(ctx, "sudo", "-n", "true").Run() != nil {
			fmt.Fprintf(stderr, "cgx uninstall refused: %s, but the process is not root and `sudo -n true` is unavailable.\n", reason)
			return errors.New("uninstall refused: multi-user host without root/sudo")
		}
	}
	// The server decides whether shared cxx artifacts may go. Local Grok state
	// is removed even when that call fails; shared artifacts are then kept.
	result := shareduninstall.ServerResult{}
	var raw json.RawMessage
	if err := client.JSON(ctx, http.MethodDelete, "/auth?engine=grok", nil, &raw, 0); err != nil {
		terminalui.Say(stderr, "cgx", terminalui.ToneWarn, "uninstall", "server-side delete failed (best-effort): "+err.Error())
	} else if decoded, err := shareduninstall.DecodeServerResult(strings.NewReader(string(raw))); err != nil {
		terminalui.Say(stderr, "cgx", terminalui.ToneWarn, "uninstall", "shared artifacts preserved; delete response was not authoritative: "+err.Error())
	} else {
		result = decoded
		terminalui.Say(stdout, "cgx", terminalui.ToneOK, "uninstall", "server-side delete confirmed")
	}
	var errs error
	step := func(what string, err error) {
		if err != nil {
			errs = errors.Join(errs, fmt.Errorf("%s: %w", what, err))
			terminalui.Say(stderr, "cgx", terminalui.ToneFail, "uninstall", what+": "+err.Error())
			return
		}
		terminalui.Say(stdout, "cgx", terminalui.ToneOK, "uninstall", what)
	}
	step("removed pending login", clearPendingLogin())
	if store, err := native.Skills(); err != nil {
		step("removed fleet skills", err)
	} else {
		step("removed fleet skills", store.Strip())
	}
	step("removed managed config keys", native.SyncConfig(home, nil, []string{}))
	state, err := native.StateDir()
	if err != nil {
		return errors.Join(errs, err)
	}
	if digest, err := os.ReadFile(filepath.Join(state, "managed-agents.sha256")); err == nil {
		if body, err := os.ReadFile(filepath.Join(home, "AGENTS.md")); err == nil {
			sum := sha256.Sum256(body)
			if strings.TrimSpace(string(digest)) == hex.EncodeToString(sum[:]) {
				step("removed managed AGENTS.md", os.Remove(filepath.Join(home, "AGENTS.md")))
			}
		}
	}
	for _, name := range []string{"grok-bin", "managed-keys.json", "managed-agents.sha256"} {
		if err := os.Remove(filepath.Join(state, name)); err != nil && !os.IsNotExist(err) {
			errs = errors.Join(errs, err)
		}
	}
	step("removed signed cgx config", fleetconfig.Remove(ctx, "grok"))
	if storeDir, err := native.StoreDir(); err == nil {
		// The maintenance guard above proves no cgx process still runs a copy.
		step("removed private Grok installs", errors.Join(native.RemoveInstalledCopies(), os.RemoveAll(storeDir)))
	}
	exe, err := os.Executable()
	if err != nil {
		return errors.Join(errs, err)
	}
	switch {
	case !result.Confirmed:
		terminalui.Say(stderr, "cgx", terminalui.ToneWarn, "uninstall", "shared cxx aliases and cron preserved because remaining engines were not confirmed")
	default:
		if err := shareduninstall.Apply(ctx, result, "grok", exe); err != nil {
			step("shared cxx cleanup", err)
		} else if len(result.RemainingEngines) == 0 {
			terminalui.Say(stdout, "cgx", terminalui.ToneOK, "uninstall", "removed last-engine cxx aliases, binary, and managed cron")
		} else {
			terminalui.Say(stdout, "cgx", terminalui.ToneOK, "uninstall", "removed cgx alias; shared cxx and cron retained")
		}
	}
	return errs
}

// otherHostUsers asks the orchestrator which other accounts on this host run
// fleet wrappers. The call also records the current user, as cdx/clx do.
func otherHostUsers(ctx context.Context, client *orchestrator.Client) ([]string, error) {
	username := os.Getenv("USER")
	if current, err := user.Current(); err == nil && current.Username != "" {
		username = current.Username
	}
	hostname, _ := os.Hostname()
	type hostUser struct {
		Username string `json:"username"`
	}
	var resp struct {
		Users []hostUser `json:"users"`
		Data  struct {
			Users []hostUser `json:"users"`
		} `json:"data"`
	}
	if err := client.JSON(ctx, http.MethodPost, "/host/users", map[string]any{"username": username, "hostname": hostname}, &resp, 0); err != nil {
		return nil, err
	}
	users := resp.Users
	if len(users) == 0 {
		users = resp.Data.Users
	}
	seen := map[string]bool{username: true}
	out := []string{}
	for _, u := range users {
		if u.Username != "" && !seen[u.Username] {
			seen[u.Username] = true
			out = append(out, u.Username)
		}
	}
	return out, nil
}

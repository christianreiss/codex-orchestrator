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
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	hostcron "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	hostmaintenance "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/maintenance"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/quotaadvice"
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
	if o.command == "version" {
		fmt.Fprintf(stdout, "cgx %s (%s, %s)\n", Version, Commit, BuildDate)
		return 0
	}
	if o.command == "help" {
		PrintWrapperHelp(stdout, terminalui.DetectCapsFor(stdout, "auto"))
		return 0
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if o.command == "run" && len(o.args) > 0 && (o.args[0] == "--help" || o.args[0] == "-h" || o.args[0] == "--version" || o.args[0] == "-v") {
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
		if !hostcron.IsEngineOnly() {
			err = hostcron.Run(ctx, cfg, o.skipBoot, stdout, stderr)
		} else {
			err = maintenance(ctx, cfg, client, false, stdout, stderr)
		}
	case "uninstall":
		err = uninstall(ctx, cfg, client)
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

func syncMeasuredManaged(ctx context.Context, cfg *config.Config, client *orchestrator.Client) (summary managedSyncSummary, syncErr error) {
	lock, err := ipc.TryAcquireExclusive("cgx-sync")
	if err != nil {
		return summary, fmt.Errorf("managed Grok sync lock: %w", err)
	}
	defer lock.Release()
	home, err := native.Home()
	if err != nil {
		return summary, err
	}
	bundle, err := client.SyncBootstrap(ctx, orchestrator.BundleRequest{Engine: "grok", IncludeAuth: false, Home: home})
	if err != nil {
		return summary, fmt.Errorf("Grok managed sync unavailable: %w", err)
	}
	summary.Sessions = bundle.Sessions
	// SyncBootstrap already unwraps resource objects to document bytes.
	if body := bundle.Agents; len(body) > 0 {
		before := documentDigest(filepath.Join(home, "AGENTS.md"))
		if err := native.AtomicWrite(filepath.Join(home, "AGENTS.md"), body, 0o600); err != nil {
			return summary, err
		}
		state, err := native.StateDir()
		if err != nil {
			return summary, err
		}
		digest := sha256.Sum256(body)
		if err := native.AtomicWrite(filepath.Join(state, "managed-agents.sha256"), []byte(hex.EncodeToString(digest[:])), 0o600); err != nil {
			return summary, err
		}
		summary.Config.Updated = before != hex.EncodeToString(digest[:])
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

	var skills map[string]any
	if err := client.JSON(ctx, http.MethodGet, "/skills?engine=grok", nil, &skills, 0); err != nil {
		return summary, err
	}
	summary.Skills.Checked = true
	username := os.Getenv("USER")
	if current, err := user.Current(); err == nil {
		username = current.Username
	}
	hostname, _ := os.Hostname()
	if username != "" {
		_ = client.JSON(ctx, http.MethodPost, "/host/users", map[string]any{"username": username, "hostname": hostname}, nil, 0)
	}
	return summary, reconcilePeers(ctx, cfg)
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
	for _, engine := range engines {
		if engine == cfg.Engine {
			continue
		}
		item, err := fleetconfig.Fetch(ctx, cfg, engine)
		if err != nil {
			return err
		}
		if err := fleetconfig.Persist(ctx, item); err != nil {
			return err
		}
	}
	_, err = layout.EnsureAliases(ctx, exe, engines)
	return err
}

func run(ctx context.Context, cfg *config.Config, client *orchestrator.Client, o options, stdout, stderr io.Writer) (exitCode int, runErr error) {
	sync, syncErr := syncMeasuredManaged(ctx, cfg, client)
	if syncErr != nil {
		if !(o.concurrent && errors.Is(syncErr, ipc.ErrHeld)) {
			return 1, syncErr
		}
		sync.Concurrent = true
	}
	baseHome, err := native.Home()
	if err != nil {
		return 1, err
	}
	pool := accountpool.Load("grok", filepath.Join(baseHome, "auth.json"), cfg.Orchestrator.BaseURL)
	client.Pool = pool
	var initial startupAuth
	if err := client.JSON(ctx, http.MethodPost, "/auth", map[string]any{"engine": "grok", "command": "retrieve"}, &initial, 0); err != nil {
		return 1, errors.New("Grok subscription auth unavailable; run cgx login")
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
	restore := agentportal.ScrubEnvironment()
	defer restore()
	args := append([]string(nil), o.args...)
	headless := o.command == "execute" || hasArg(args, "-p", "--single", "--print", "--prompt-file") || len(args) > 0 && args[0] == "agent"
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
	portal, portalErr := agentportal.Start(ctx, cfg, agentportal.StartInput{Engine: "grok", InvocationKind: map[bool]string{true: "execute", false: "interactive"}[headless], Resumed: hasArg(args, "--resume", "--continue", "-r", "-c"), UpstreamSessionID: agentportal.ExplicitResumeSessionID(args)})
	if portalErr != nil {
		fmt.Fprintln(stderr, "cgx: agent portal temporarily unavailable")
	}
	if portal != nil {
		broker, err := portal.StartBroker(ctx)
		if err == nil {
			defer broker.Close()
			restoreBroker := broker.ActivateEnvironment()
			defer restoreBroker()
		}
		stop := portal.StartHeartbeat(ctx)
		defer stop()
		defer func() {
			state, summary := "completed", "Grok session ended"
			if runErr != nil || exitCode != 0 {
				state, summary = "failed", "Grok session failed"
			}
			portal.Finish(state, summary)
		}()
	}
	exe, err := os.Executable()
	if err != nil {
		return 1, err
	}
	if err := rt.Configure(exe, cfg, portal != nil); err != nil {
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
	if !headless && !hasArg(args, "--no-leader", "--leader-socket") {
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
	} else if headless && !hasArg(args, "--no-leader", "--leader-socket", "--leader") {
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
	cmd.Stdout = stdout
	cmd.Stderr = stderr
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
		err = cmd.Wait()
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
	err := client.JSON(ctx, http.MethodPost, "/auth", map[string]any{"engine": "grok", "command": "retrieve"}, &auth, 0)
	home, _ := native.Home()
	screen := startupScreen(startupInput{Config: cfg, Auth: &auth, AuthErr: err, EngineVersion: version, VersionErr: findErr, WrapperVersion: Version, Home: home, StatusOnly: true, Minimal: o.minimal})
	terminalui.PrintBootScreen(stdout, screen)
	if doctor && screen.ResultTone == terminalui.ToneFail {
		return errors.New("Grok doctor checks failed")
	}
	return err
}

func maintenance(ctx context.Context, cfg *config.Config, client *orchestrator.Client, force bool, stdout, stderr io.Writer) error {
	path, _ := native.FindCLI()
	version := ""
	if path != "" {
		version, _ = native.ProbeVersion(ctx, path)
	}
	check, err := client.CronCheck(ctx, orchestrator.CronCheckRequest{Engine: "grok", ClientVersion: version, WrapperVersion: Version})
	if err != nil {
		return err
	}
	if check.Wrapper != nil && check.Wrapper.Action == "update" {
		installed, err := coreupdate.Install(ctx, cfg, check.Wrapper.URL, check.Wrapper.SHA256, check.Wrapper.TargetVersion, client.Logger)
		if err != nil {
			return err
		}
		engine := "grok"
		args := []string{"sync"}
		if HostSyncAfterUpdate {
			engine = ""
		}
		return syscall.Exec(installed, layout.ReexecArgv(installed, engine, args), os.Environ())
	}
	target := check.TargetVersion
	if target == "" {
		target = native.PinnedVersion
	}
	if force || check.Action == "update" || path == "" {
		path, err = native.Install(ctx, target)
		if err != nil {
			return err
		}
		version, err = native.ProbeVersion(ctx, path)
		if err != nil {
			return err
		}
	}
	if err := syncManaged(ctx, cfg, client); err != nil {
		return err
	}
	if !hostcron.IsCoordinated() {
		if err := hostcron.Install(ctx, cfg); err != nil {
			return err
		}
	}
	_ = native.Prune()
	return client.CronReport(ctx, orchestrator.CronReportRequest{Engine: "grok", ClientVersion: version, WrapperVersion: Version})
}

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
func uninstall(ctx context.Context, cfg *config.Config, client *orchestrator.Client) error {
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
	var raw json.RawMessage
	if err := client.JSON(ctx, http.MethodDelete, "/auth?engine=grok", nil, &raw, 0); err != nil {
		return err
	}
	result, err := shareduninstall.DecodeServerResult(strings.NewReader(string(raw)))
	if err != nil {
		return err
	}
	if err := clearPendingLogin(); err != nil {
		return err
	}
	if err := fleetconfig.Remove(ctx, "grok"); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if err := shareduninstall.Apply(ctx, result, "grok", exe); err != nil {
		return err
	}
	state, err := native.StateDir()
	if err != nil {
		return err
	}
	if err := native.SyncConfig(home, nil, []string{}); err != nil {
		return err
	}
	if digest, err := os.ReadFile(filepath.Join(state, "managed-agents.sha256")); err == nil {
		if body, err := os.ReadFile(filepath.Join(home, "AGENTS.md")); err == nil {
			sum := sha256.Sum256(body)
			if strings.TrimSpace(string(digest)) == hex.EncodeToString(sum[:]) {
				if err := os.Remove(filepath.Join(home, "AGENTS.md")); err != nil {
					return err
				}
			}
		}
	}
	for _, name := range []string{"grok-bin", "managed-keys.json", "managed-agents.sha256"} {
		if err := os.Remove(filepath.Join(state, name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return native.RemoveInstalledCopies()
}

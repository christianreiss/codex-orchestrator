package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"io"
	"math/rand/v2"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
)

var daemonExecutable = os.Executable
var reconcileHostDaemon = ReconcileHostDaemon

// ReconcileConfiguredHostDaemon runs after managed sync and before a native
// launch. Disabled messaging and non-Linux hosts have no daemon to manage.
// Optional service failures remain visible without blocking a native session.
func ReconcileConfiguredHostDaemon(cfg *config.Config, output io.Writer) {
	if runtime.GOOS != "linux" || cfg == nil || (!cfg.AgentMessaging.Enabled && cfg.Orchestrator.CommunicatorRuntimeProtocol != residency.Protocol) || cfg.EngineSuspended(cfg.Engine) || cfg.SourcePath() == "" || os.Getenv("CXX_DAEMON_OPERATION_ID") != "" || os.Getenv("CXX_AGENT_MESSAGING_MESSAGE_ID") != "" {
		return
	}
	if err := reconcileHostDaemon(output, output); err != nil {
		fmt.Fprintln(output, "host daemon:", err)
	}
}

type daemonSettings struct {
	Enabled            bool   `json:"enabled"`
	ResidentEnabled    bool   `json:"resident_enabled"`
	ExecutionRequested bool   `json:"execution_requested"`
	ExpiresAt          string `json:"expires_at"`
	Username           string `json:"username"`
	MaxParallel        int    `json:"max_parallel"`
}
type daemonOperation struct {
	ID         string `json:"operation_id"`
	Claim      string `json:"claim_id"`
	Session    string `json:"session_id"`
	Engine     string `json:"engine"`
	Cwd        string `json:"cwd"`
	Title      string `json:"title"`
	Prompt     string `json:"prompt"`
	Address    string `json:"address"`
	Generation int    `json:"binding_generation"`
	Upstream   string `json:"upstream_session_id"`
	// Model is pinned per daemon session (Fleet Advisor); empty uses the host's.
	Model string `json:"model,omitempty"`
}
type daemonResult struct {
	Status   string `json:"status"`
	Reply    string `json:"reply"`
	Upstream string `json:"upstream_session_id,omitempty"`
}
type daemonJournal struct {
	Operation daemonOperation `json:"operation"`
	Result    *daemonResult   `json:"result,omitempty"`
}
type daemonFrame struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	Result    json.RawMessage `json:"result"`
	Error     string          `json:"error"`
	Operation daemonOperation `json:"operation"`
}

// A server rejection confirms that this RPC did not grant a launch. Transport
// failures remain ambiguous and must retain the durable local journal.
type daemonRejection struct{ message string }

func (e *daemonRejection) Error() string { return e.message }

type daemonConnection struct {
	ws      residency.DaemonStream
	mu      sync.Mutex
	pending map[string]chan daemonFrame
	done    chan struct{}
}

func (c *daemonConnection) rpc(ctx context.Context, kind string, payload any, out any) error {
	id := newUUID()
	ch := make(chan daemonFrame, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()
	if err := c.ws.Send(map[string]any{"id": id, "type": kind, "payload": payload}); err != nil {
		return err
	}
	select {
	case result := <-ch:
		if result.Error != "" {
			return &daemonRejection{message: result.Error}
		}
		if out != nil {
			return json.Unmarshal(result.Result, out)
		}
		return nil
	case <-c.done:
		return errors.New("daemon connection closed")
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(30 * time.Second):
		return errors.New("daemon request timed out")
	}
}

// daemonVersion is the running binary's version, for the resident update's
// no-downgrade check.
var daemonVersion string

// RunDaemonCommand controls only the explicitly enabled host execution service.
func RunDaemonCommand(args []string, stdout, stderr io.Writer, version string) int {
	if runtime.GOOS != "linux" {
		fmt.Fprintln(stderr, "host daemon requires Linux/systemd")
		return 1
	}
	if len(args) != 1 {
		fmt.Fprintln(stderr, "usage: cxx daemon install|status|start|stop|uninstall|run")
		return 2
	}
	daemonVersion = version
	var err error
	if args[0] == "reconcile" {
		err = ReconcileHostDaemon(stdout, stderr)
	} else if args[0] == "run" {
		err = runHostDaemon(context.Background(), version, stdout, stderr)
	} else {
		err = daemonService(args[0], stdout, stderr)
	}
	if err != nil {
		fmt.Fprintln(stderr, "cxx daemon:", err)
		return 1
	}
	return 0
}

func daemonConfig(ctx context.Context) (map[string]*config.Config, *relayClient, daemonSettings, error) {
	return daemonConfigWithController(ctx, nil)
}

func daemonConfigWithController(ctx context.Context, controller *ResidentController) (map[string]*config.Config, *relayClient, daemonSettings, error) {
	configs, seed, err := loadMessagingConfigs()
	if controller == nil && seed == nil && err == nil && residentConfigurationEnabled() {
		configs, seed, err = loadResidentConfigs()
	}
	if err != nil {
		return nil, nil, daemonSettings{}, err
	}
	if seed == nil {
		return nil, nil, daemonSettings{}, errors.New("no signed messaging-enabled engine config available")
	}
	client, err := newRelayClient(seed)
	if err != nil {
		return nil, nil, daemonSettings{}, err
	}
	controller.wrapClient(client)
	var settings daemonSettings
	err = doJSON(ctx, client.http, client.baseURL, http.MethodGet, "/host/daemon/config", nil, map[string]string{"X-API-Key": client.apiKey}, &settings)
	if err == nil {
		err = rememberDaemonDeadline(settings)
		if deadlineExpired(settings.ExpiresAt, time.Now()) {
			settings.Enabled = false
		}
	}
	return configs, client, settings, err
}

// ReconcileHostDaemon is called after wrapper sync. Unprivileged installs report
// pending instead of escalating; existing per-user messaging remains independent.
func ReconcileHostDaemon(stdout, stderr io.Writer) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, _, settings, err := daemonConfig(ctx)
	if err != nil {
		return err
	}
	if !residentRequested(settings, residentConfigurationEnabled()) {
		return nil
	} // the connected service drains itself
	if os.Geteuid() != 0 {
		return unprivilegedDaemonPending(daemonUnitPath)
	}
	return daemonService("install", stdout, stderr)
}

const daemonUnitPath = "/etc/systemd/system/cxx-daemon.service"

// unprivilegedDaemonPending keeps current installs quiet, but never treats an
// existing unit as proof that its private binary matches this wrapper.
func unprivilegedDaemonPending(unitPath string) error {
	if _, err := os.Stat(unitPath); err != nil {
		return errors.New("daemon enabled: run 'sudo cxx daemon install' to install the system service")
	}
	exe, err := daemonExecutable()
	if err != nil {
		return errors.New("daemon update unverified: run 'sudo cxx daemon install' to reconcile the system service")
	}
	return daemonBinaryPending(exe, "/usr/local/lib/cxx-daemon/cxx")
}

func daemonBinaryPending(wrapper, installed string) error {
	candidate, candidateErr := residency.DigestFile(wrapper)
	current, currentErr := residency.DigestFile(installed)
	if candidateErr != nil || currentErr != nil {
		return errors.New("daemon update unverified: run 'sudo cxx daemon install' to reconcile the system service")
	}
	if candidate != current {
		return errors.New("daemon update pending: installed binary differs from this wrapper; run 'sudo cxx daemon install'")
	}
	return nil
}

func daemonService(action string, stdout, stderr io.Writer) error {
	if action == "status" {
		return runServiceProcess(stdout, stderr, "systemctl", "status", "cxx-daemon.service")
	}
	if os.Geteuid() != 0 {
		return errors.New("system daemon management requires root")
	}
	switch action {
	case "start", "stop":
		return runServiceProcess(stdout, stderr, "systemctl", action, "cxx-daemon.service")
	case "apply-update":
		return applyResidentUpdate(daemonVersion, stdout, stderr)
	case "uninstall":
		if err := runServiceProcess(stdout, stderr, "systemctl", "disable", "--now", "cxx-daemon.service"); err != nil {
			return err
		}
		if err := os.Remove(daemonUnitPath); err != nil && !os.IsNotExist(err) {
			return err
		}
		return runServiceProcess(stdout, stderr, "systemctl", "daemon-reload")
	case "install":
		configs, client, settings, err := daemonConfig(context.Background())
		if err != nil {
			return err
		}
		if !residentRequested(settings, residentConfigurationEnabled()) {
			if settings.ResidentEnabled || settings.ExecutionRequested {
				return errors.New("resident service requires signed runtime support; migration remains pending")
			}
			return errors.New("enable the host daemon in the WebUI first")
		}
		account, err := user.Lookup(settings.Username)
		if err != nil {
			return err
		}
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		body, err := os.ReadFile(exe)
		if err != nil {
			return err
		}
		installed := "/usr/local/lib/cxx-daemon/cxx"
		if err := os.MkdirAll(filepath.Dir(installed), 0755); err != nil {
			return err
		}
		old, _ := os.ReadFile(installed)
		changed := string(old) != string(body)
		var env strings.Builder
		for _, engine := range []string{"codex", "claude", "grok"} {
			cfg := configs[engine]
			if cfg == nil {
				continue
			}
			key := map[string]string{"codex": "CDX_CONFIG_PATH", "claude": "CLX_CONFIG_PATH", "grok": "CGX_CONFIG_PATH"}[engine]
			path, ok := daemonAccountConfigPath(cfg.SourcePath(), engine, account.HomeDir)
			if !ok {
				continue
			}
			fmt.Fprintf(&env, "Environment=%s\n", systemdQuote(key+"="+path))
		}
		if env.Len() == 0 {
			return fmt.Errorf("daemon user %s has no enrolled engine config under %s", settings.Username, account.HomeDir)
		}
		unit := hostDaemonUnit(settings.Username, account.HomeDir, env.String(), installed)
		if residentConfigurationEnabled() {
			unit = strings.Replace(unit, " daemon run\n", " communicator run\n", 1)
			unit = strings.Replace(unit, "KillMode=control-group\n", "KillMode=process\n", 1)
		}
		if residentConfigurationEnabled() {
			// Installed before any migration branch so every resident install,
			// fresh or migrated, can receive unprivileged update handoffs.
			handoffEnv := "Environment=" + systemdQuote("HOME="+account.HomeDir) + "\n" + env.String()
			if err := installResidentUpdateHandoff(account, handoffEnv, installed, stdout, stderr); err != nil {
				return fmt.Errorf("resident update handoff: %w", err)
			}
		}
		oldUnit, _ := os.ReadFile(daemonUnitPath)
		runtimeTransition := residentConfigurationEnabled() || strings.Contains(string(oldUnit), " communicator run\n")
		if runtimeTransition && strings.Contains(string(oldUnit), "XDG_RUNTIME_DIR=") {
			return errors.New("resident migration pending: preserve the explicit systemd runtime namespace before changing this unit")
		}
		if runtimeTransition {
			pid, err := serviceMainPID()
			if err != nil {
				return err
			}
			if pid > 0 {
				actual, err := residency.DigestFile(fmt.Sprintf("/proc/%d/exe", pid))
				if err != nil {
					return err
				}
				candidate, err := residency.DigestFile(exe)
				if err != nil {
					return err
				}
				changed = changed || actual != candidate
			}
		}

		journal, journalErr := residency.ReadJournal(filepath.Join(filepath.Dir(installed), "migration", "transition.json"))
		pending := journalErr == nil && journal.Phase != residency.Reopened
		if runtimeTransition && journalErr != nil && !errors.Is(journalErr, os.ErrNotExist) {
			return journalErr
		}
		if runtimeTransition && (changed || string(oldUnit) != unit || pending) {
			pid, err := serviceMainPID()
			if err != nil {
				return err
			}
			if pid != 0 || pending {
				return migrateResidentService(configs, client, settings, account, installed, unit, stdout, stderr)
			}
			if err := guardResidentReplacement(); err != nil {
				return err
			}
			digest, err := residency.DigestFile(exe)
			if err != nil {
				return err
			}
			stageDir := filepath.Join(filepath.Dir(installed), "staged")
			staged, err := residency.StageBinary(exe, stageDir, digest)
			if err != nil {
				return err
			}
			body, err = os.ReadFile(staged)
			if err != nil {
				return err
			}
			if len(old) > 0 {
				previous, err := residency.DigestFile(installed)
				if err != nil {
					return err
				}
				if _, err := residency.StageBinary(installed, stageDir, previous); err != nil {
					return err
				}
			}
		}
		if changed {
			if err := replaceServiceBinary(installed, body); err != nil {
				return err
			}
		}
		unitChanged, err := writeProtectedFileIfChanged(daemonUnitPath, []byte(unit))
		if err != nil {
			return err
		}
		if err := runServiceProcess(stdout, stderr, "systemctl", "daemon-reload"); err != nil {
			return err
		}
		if err := runServiceProcess(stdout, stderr, "systemctl", "enable", "cxx-daemon.service"); err != nil {
			return err
		}
		verb := "start"
		if changed || unitChanged {
			verb = "restart"
		}
		if err := runServiceProcess(stdout, stderr, "systemctl", verb, "cxx-daemon.service"); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "host daemon: cxx-daemon.service enabled · %sed (connection: cxx daemon status)\n", verb)
		return nil
	default:
		return fmt.Errorf("unknown daemon action %q", action)
	}
}

// systemd treats WorkingDirectory as a path, not a quoted command argument.
// Its tilde form resolves the configured service user's home without escaping.
func hostDaemonUnit(username, home, environment, installed string) string {
	return fmt.Sprintf("[Unit]\nDescription=Codex Orchestrator optional host daemon\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nUser=%s\nWorkingDirectory=~\nEnvironment=%s\n%sExecStart=%s daemon run\nRestart=on-failure\nRestartSec=5\nUMask=0077\nKillMode=control-group\nTimeoutStopSec=45\n[Install]\nWantedBy=multi-user.target\n", username, systemdQuote("HOME="+home), environment, systemdQuote(installed))
}

func daemonStateDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".cxx", "daemon")
	return dir, os.MkdirAll(dir, 0700)
}
func saveDaemonJournal(dir string, j daemonJournal) error {
	body, err := json.Marshal(j)
	if err != nil {
		return err
	}
	if err := writeProtectedFile(filepath.Join(dir, j.Operation.ID+".json"), body); err != nil {
		return err
	}
	parent, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

func runHostDaemon(parent context.Context, version string, stdout, stderr io.Writer) error {
	return runHostExecution(parent, version, stdout, stderr, nil)
}

func runHostExecution(parent context.Context, version string, stdout, stderr io.Writer, controller *ResidentController) error {
	ctx, cancel := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	dir, err := daemonStateDir()
	if err != nil {
		return err
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(dir, "daemon.lock"))
	if err != nil {
		return err
	}
	defer lock.Release()
	instancePath := filepath.Join(dir, "instance")
	raw, _ := os.ReadFile(instancePath)
	instance := strings.TrimSpace(string(raw))
	if instance == "" {
		instance = newUUID()
		if err := writeProtectedFile(instancePath, []byte(instance)); err != nil {
			return err
		}
	}
	recoverDaemonPeerReceipts(dir)
	active := map[string]context.CancelFunc{}
	var activeMu sync.Mutex
	var workers sync.WaitGroup
	controller.bindSnapshot(func() (residency.Workload, error) {
		activeMu.Lock()
		count := len(active)
		activeMu.Unlock()
		receipts, err := verifiedPendingReceipts(dir)
		return residency.Workload{Accepted: count, Children: count, Receipts: receipts}, err
	})
	defer func() {
		cancel()
		activeMu.Lock()
		for _, stop := range active {
			stop()
		}
		activeMu.Unlock()
		workers.Wait()
	}()
	workers.Add(1)
	go func() {
		defer workers.Done()
		runDaemonPeersControlled(ctx, version, &activeMu, active, stderr, controller)
	}()
	var connectionMu sync.Mutex
	var connection *daemonConnection
	complete := func(j daemonJournal) {
		connectionMu.Lock()
		c := connection
		connectionMu.Unlock()
		if c == nil {
			return
		}
		if err := c.rpc(ctx, "complete", map[string]any{"operation_id": j.Operation.ID, "claim_id": j.Operation.Claim, "result": j.Result}, nil); err == nil {
			_ = os.Remove(filepath.Join(dir, j.Operation.ID+".json"))
		}
	}
	backoff := time.Second
	retry := func() bool {
		delay := backoff + time.Duration(rand.IntN(1000))*time.Millisecond
		backoff = min(backoff*2, 60*time.Second)
		return waitContext(ctx, delay)
	}
	connectionOwned := false
	for ctx.Err() == nil {
		activeMu.Lock()
		noActiveWork := len(active) == 0
		activeMu.Unlock()
		if daemonLocalExpired() && noActiveWork && len(pendingDaemonReceipts(dir)) == 0 {
			return nil
		}
		configs, client, settings, err := daemonConfigWithController(ctx, controller)
		if err != nil {
			fmt.Fprintln(stderr, "daemon configuration unavailable:", err)
			if !retry() {
				break
			}
			continue
		}
		activeMu.Lock()
		count := len(active)
		activeMu.Unlock()
		pendingJournals := pendingDaemonReceipts(dir)
		if (!settings.Enabled || daemonLocalExpired()) && count == 0 && len(pendingJournals) == 0 {
			return nil
		}
		if settings.Username != currentUserName() {
			return errors.New("configured daemon user differs from current user")
		}
		ws, err := controller.openDaemon(ctx, client)
		if err != nil {
			fmt.Fprintln(stderr, "daemon connection unavailable:", err)
			if !retry() {
				break
			}
			continue
		}
		c := &daemonConnection{ws: ws, pending: map[string]chan daemonFrame{}, done: make(chan struct{})}
		connectionMu.Lock()
		connection = c
		connectionMu.Unlock()
		incoming := make(chan daemonOperation, 64)
		go func() {
			defer close(c.done)
			for {
				var frame daemonFrame
				if ws.Receive(&frame) != nil {
					return
				}
				if frame.Type == "operation" {
					select {
					case incoming <- frame.Operation:
					case <-ctx.Done():
						return
					}
				} else {
					c.mu.Lock()
					ch := c.pending[frame.ID]
					c.mu.Unlock()
					if ch != nil {
						select {
						case ch <- frame:
						default:
						}
					}
				}
			}
		}()
		engines := daemonReadyEngines(configs)
		var hello struct {
			Settings daemonSettings `json:"settings"`
		}
		err = c.rpc(ctx, "hello", map[string]any{"instance_id": instance, "username": settings.Username, "version": version, "engines": engines, "error": nil}, &hello)
		if err != nil {
			fmt.Fprintln(stderr, "daemon registration rejected:", err)
			ws.Close()
			if !retry() {
				break
			}
			continue
		}
		settings = hello.Settings
		if err := rememberDaemonDeadline(settings); err != nil {
			ws.Close()
			return err
		}
		fmt.Fprintln(stdout, "host daemon connected")
		replayDaemonPeerReceipts(ctx, client)
		// An accepted launch found after process restart is ambiguous, never replayed.
		files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
		for _, path := range files {
			if filepath.Base(path) == "deadline.json" {
				continue
			}
			data, e := os.ReadFile(path)
			if e != nil {
				continue
			}
			var j daemonJournal
			if json.Unmarshal(data, &j) != nil {
				continue
			}
			activeMu.Lock()
			_, running := active[j.Operation.Session]
			activeMu.Unlock()
			if running {
				continue
			}
			if j.Result == nil {
				j.Result = &daemonResult{Status: "unknown", Reply: "Daemon restarted before a durable result; work was not repeated."}
				_ = saveDaemonJournal(dir, j)
			}
			complete(j)
		}
		state, stateErr := communicator.DialState(ctx, client.baseURL, communicator.StateScope{Topic: "daemon", NativeInstanceID: instance}, communicator.StateAuth{})
		if stateErr != nil && (connectionOwned || communicator.StateRequired(client.baseURL)) {
			ws.Close()
			if !retry() {
				break
			}
			continue
		}
		if state != nil {
			connectionOwned = true
		}
		stateRevision := ""
		stateConfigRevision := ""
		localStateChanged := make(chan struct{}, 1)
		ticker := time.NewTicker(15 * time.Second)
		stateTimer := time.NewTimer(time.Hour)
		stateTimer.Stop()
	loop:
		for {
			var changed <-chan struct{}
			tick := ticker.C
			if state != nil {
				ticker.Stop()
				tick = nil
				var view struct {
					Settings       daemonSettings `json:"settings"`
					Stop           []string       `json:"stop"`
					ConfigRevision string         `json:"config_revision"`
				}
				frame, wake, live := state.Snapshot(&view)
				changed = wake
				if !live {
					break loop
				}
				if frame.Revision != stateRevision {
					stateRevision = frame.Revision
					settings = view.Settings
					if err := rememberDaemonDeadline(settings); err != nil {
						break loop
					}
					activeMu.Lock()
					for _, id := range view.Stop {
						if stop := active[id]; stop != nil {
							stop()
						}
					}
					activeMu.Unlock()
					if view.ConfigRevision != stateConfigRevision {
						stateConfigRevision = view.ConfigRevision
						if local, _, err := loadMessagingConfigs(); err == nil && len(local) > 0 {
							configs = local
							engines = daemonReadyEngines(configs)
						}
					}
				}
				activeMu.Lock()
				count := len(active)
				activeMu.Unlock()
				if (!settings.Enabled || daemonLocalExpired()) && count == 0 && len(pendingDaemonReceipts(dir)) == 0 {
					state.Close()
					ws.Close()
					return nil
				}
				// Retry only while a journal is pending; otherwise wake at the
				// actual daemon authorization deadline or a state transition.
				delay := time.Duration(0)
				if len(pendingDaemonReceipts(dir)) > 0 {
					delay = 15 * time.Second
				}
				if settings.ExpiresAt != "" {
					if due, e := time.Parse(time.RFC3339Nano, settings.ExpiresAt); e == nil {
						left := time.Until(due)
						if left < 0 {
							left = 0
						}
						if delay == 0 || left < delay {
							delay = left
						}
						if left == 0 {
							settings.Enabled = false
						}
					}
				}
				if delay > 0 {
					stateTimer.Reset(delay)
					tick = stateTimer.C
				}
			}
			select {
			case <-changed:
				stateTimer.Stop()
				continue
			case <-localStateChanged:
				stateTimer.Stop()
				continue
			case <-ctx.Done():
				break loop
			case <-c.done:
				break loop
			case op := <-incoming:
				if daemonLocalExpired() || !settings.Enabled {
					continue
				}
				finish, allowed := controller.permit()
				if !allowed {
					continue
				}
				activeMu.Lock()
				_, running := active[op.Session]
				activeMu.Unlock()
				if running {
					finish()
					continue
				}
				if _, err := os.Stat(filepath.Join(dir, op.ID+".json")); err == nil {
					finish()
					continue
				}
				j := daemonJournal{Operation: op}
				if err := saveDaemonJournal(dir, j); err != nil {
					fmt.Fprintln(stderr, "daemon journal:", err)
					finish()
					continue
				}
				if err := c.rpc(ctx, "accept", map[string]any{"operation_id": op.ID, "claim_id": op.Claim}, nil); err != nil {
					var rejected *daemonRejection
					if errors.As(err, &rejected) {
						_ = os.Remove(filepath.Join(dir, op.ID+".json"))
					} else {
						_ = ws.Close()
					}
					finish()
					continue
				}
				runCtx, stop := context.WithCancel(ctx)
				activeMu.Lock()
				active[op.Session] = stop
				activeMu.Unlock()
				workers.Add(1)
				go func() {
					defer workers.Done()
					defer finish()
					result := runDaemonOperation(runCtx, op)
					j.Result = &result
					if err := saveDaemonJournal(dir, j); err != nil {
						fmt.Fprintln(stderr, "daemon result journal:", err)
					} else {
						complete(j)
					}
					activeMu.Lock()
					delete(active, op.Session)
					activeMu.Unlock()
					select {
					case localStateChanged <- struct{}{}:
					default:
					}
					stop()
				}()
			case <-tick:
				replayDaemonPeerReceipts(ctx, client)
				if daemonLocalExpired() {
					settings.Enabled = false
				}
				if state == nil {
					if refreshed, _, _, e := daemonConfigWithController(ctx, controller); e == nil {
						configs = refreshed
						engines = daemonReadyEngines(configs)
					}
				}
				var heartbeat struct {
					Settings daemonSettings `json:"settings"`
					Stop     []string       `json:"stop"`
				}
				activeMu.Lock()
				activeSessions := make([]string, 0, len(active))
				for id := range active {
					activeSessions = append(activeSessions, id)
				}
				activeMu.Unlock()
				if state == nil {
					if err := c.rpc(ctx, "heartbeat", map[string]any{"engines": engines, "error": nil, "active_sessions": activeSessions}, &heartbeat); err != nil {
						break loop
					}
				} else {
					heartbeat.Settings = settings
				}
				backoff = time.Second
				activeMu.Lock()
				for _, id := range heartbeat.Stop {
					if stop := active[id]; stop != nil {
						stop()
					}
				}
				count := len(active)
				activeMu.Unlock()
				pendingJournals := pendingDaemonReceipts(dir)
				settings = heartbeat.Settings
				if err := rememberDaemonDeadline(settings); err != nil {
					break loop
				}
				if (!settings.Enabled || daemonLocalExpired()) && count == 0 && len(pendingJournals) == 0 {
					ticker.Stop()
					ws.Close()
					return nil
				}
				// Retry receipts without rerunning the native process.
				files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
				for _, path := range files {
					if filepath.Base(path) == "deadline.json" {
						continue
					}
					data, e := os.ReadFile(path)
					if e != nil {
						continue
					}
					var j daemonJournal
					if json.Unmarshal(data, &j) == nil && j.Result != nil {
						complete(j)
					}
				}
			}
		}
		stateTimer.Stop()
		if state != nil {
			state.Close()
		}
		ticker.Stop()
		ws.Close()
		connectionMu.Lock()
		if connection == c {
			connection = nil
		}
		connectionMu.Unlock()
		if !retry() {
			break
		}
	}
	return nil
}

func runDaemonOperation(ctx context.Context, op daemonOperation) daemonResult {
	if op.Cwd == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return daemonResult{Status: "failed", Reply: "Service user home directory unavailable"}
		}
		op.Cwd = home
	}
	if !filepath.IsAbs(op.Cwd) {
		return daemonResult{Status: "failed", Reply: "Working directory must be absolute"}
	}
	info, err := os.Stat(op.Cwd)
	if err != nil || !info.IsDir() {
		return daemonResult{Status: "failed", Reply: "Working directory does not exist"}
	}
	if op.Engine != "codex" && op.Engine != "claude" && op.Engine != "grok" {
		return daemonResult{Status: "failed", Reply: "Unknown engine"}
	}
	if op.Upstream != "" {
		lockPath, err := writerLockPath(op.Engine, op.Upstream)
		if err != nil {
			return daemonResult{Status: "failed", Reply: "Native session lock unavailable"}
		}
		lock, err := ipc.TryAcquireExclusivePath(lockPath)
		if err != nil {
			return daemonResult{Status: "failed", Reply: "Native session already has a writer"}
		}
		defer lock.Release()
	}
	exe, err := daemonExecutable()
	if err != nil {
		return daemonResult{Status: "failed", Reply: err.Error()}
	}
	args := nativeArgs(op.Engine, op.Upstream, op.Model)
	prompt := op.Prompt + "\n\nSession title: " + op.Title
	if op.Engine == config.EngineGrok {
		file, err := os.CreateTemp("", "cxx-daemon-prompt-*")
		if err != nil {
			return daemonResult{Status: "failed", Reply: err.Error()}
		}
		defer os.Remove(file.Name())
		if _, err = file.WriteString(prompt); err != nil {
			file.Close()
			return daemonResult{Status: "failed", Reply: err.Error()}
		}
		file.Close()
		args = append(args, "--prompt-file", file.Name())
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = op.Cwd
	cmd.Stdin = strings.NewReader(prompt)
	if op.Engine == config.EngineGrok {
		cmd.Stdin = nil
	}
	cmd.Env = append(os.Environ(), "CXX_DAEMON_OPERATION_ID="+op.ID, "CXX_DAEMON_CLAIM_ID="+op.Claim)
	if op.Address != "" {
		cmd.Env = append(cmd.Env, "CXX_AGENT_MESSAGING_ADDRESS="+op.Address, "CXX_AGENT_MESSAGING_BINDING_GENERATION="+strconv.Itoa(op.Generation), "CXX_AGENT_MESSAGING_CONTINUITY=native", "CXX_AGENT_MESSAGING_UPSTREAM_SESSION_ID="+op.Upstream)
	}
	if op.Upstream != "" {
		// This parent holds the writer lock until the child has exited.
		cmd.Env = append(cmd.Env, "CXX_DAEMON_NATIVE_WRITER_ID="+op.Upstream)
	}
	startupFile, _ := os.CreateTemp("", "cxx-daemon-startup-*.json")
	startupPath := ""
	if startupFile != nil {
		startupPath = startupFile.Name()
		defer os.Remove(startupPath)
		defer startupFile.Close()
	}
	cmd.Env = append(cmd.Env, agentportal.StartupFailureEnv+"="+startupPath)
	var output, diagnostic tailBuffer
	output.limit = workerOutputLimit
	diagnostic.limit = 64 * 1024
	cmd.Stdout = &output
	cmd.Stderr = &diagnostic
	prepareDaemonProcess(cmd)
	if err := cmd.Start(); err != nil {
		return daemonResult{Status: "failed", Reply: err.Error()}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-ctx.Done():
		stopDaemonProcess(cmd, done)
		return daemonResult{Status: "stopped", Reply: "Remote process stopped"}
	}
	reply, upstream := parseNativeOutput(op.Engine, output.Bytes())
	if err != nil {
		failure := "Native process exited unsuccessfully"
		if cmd.ProcessState != nil {
			failure += fmt.Sprintf("; exit_status=%d", cmd.ProcessState.ExitCode())
		}
		if startupFile != nil {
			if startup := agentportal.ReadStartupFailure(startupFile); startup != "" {
				failure += "; " + startup
			}
		}
		return daemonResult{Status: "failed", Reply: failure, Upstream: upstream}
	}
	if reply == "" || upstream == "" {
		return daemonResult{Status: "unknown", Reply: "Native process ended without a verifiable session result"}
	}
	if len([]rune(reply)) > 99_000 {
		reply = string([]rune(reply)[:99_000]) + "\n[Remote result truncated; see native session for full output.]"
	}
	return daemonResult{Status: "completed", Reply: reply, Upstream: upstream}
}

func daemonReadyEngines(configs map[string]*config.Config) []string {
	engines := []string{}
	for engine := range configs {
		var err error
		switch engine {
		case config.EngineCodex:
			_, err = codex.FindCLI()
		case config.EngineClaude:
			_, err = claude.FindCLI()
		case config.EngineGrok:
			_, err = grok.FindCLI()
		default:
			continue
		}
		if err == nil {
			engines = append(engines, engine)
		}
	}
	return engines
}

func pendingDaemonReceipts(dir string) []string {
	all, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	work := make([]string, 0, len(all))
	for _, path := range all {
		if filepath.Base(path) != "deadline.json" {
			work = append(work, path)
		}
	}
	peers, _ := filepath.Glob(filepath.Join(dir, "receipts", "*.json"))
	return append(work, peers...)
}

// daemonAccountConfigPath keeps the unit on the daemon account's own configs.
// The configs loaded here belong to whoever runs the install; when that is
// root installing a daemon for chris, root's paths made the daemon fail with
// "no active signed engine config available for residence" (feedback
// d69d6e38). A path already under the daemon's home is used as is; otherwise
// the account's default path is used when that file exists.
func daemonAccountConfigPath(loaded, engine, home string) (string, bool) {
	if home != "" && strings.HasPrefix(filepath.Clean(loaded), filepath.Clean(home)+string(filepath.Separator)) {
		return loaded, true
	}
	name := map[string]string{"codex": "cdx.json", "claude": "clx.json", "grok": "cgx.json"}[engine]
	if name == "" || home == "" {
		return "", false
	}
	candidate := filepath.Join(home, ".config", "codex-orchestrator", name)
	if _, err := os.Stat(candidate); err != nil {
		return "", false
	}
	return candidate, true
}

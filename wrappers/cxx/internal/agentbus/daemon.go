package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"golang.org/x/net/websocket"
)

var daemonExecutable = os.Executable

type daemonSettings struct {
	Enabled     bool   `json:"enabled"`
	Username    string `json:"username"`
	MaxParallel int    `json:"max_parallel"`
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
	ws      *websocket.Conn
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
	if err := websocket.JSON.Send(c.ws, map[string]any{"id": id, "type": kind, "payload": payload}); err != nil {
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
	configs, seed, err := loadMessagingConfigs()
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
	var settings daemonSettings
	err = doJSON(ctx, client.http, client.baseURL, http.MethodGet, "/host/daemon/config", nil, map[string]string{"X-API-Key": client.apiKey}, &settings)
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
	if !settings.Enabled {
		return nil
	} // the connected service drains itself
	if os.Geteuid() != 0 {
		return errors.New("daemon enabled: run 'sudo cxx daemon install' to install the system service")
	}
	return daemonService("install", stdout, stderr)
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
	case "uninstall":
		if err := runServiceProcess(stdout, stderr, "systemctl", "disable", "--now", "cxx-daemon.service"); err != nil {
			return err
		}
		if err := os.Remove("/etc/systemd/system/cxx-daemon.service"); err != nil && !os.IsNotExist(err) {
			return err
		}
		return runServiceProcess(stdout, stderr, "systemctl", "daemon-reload")
	case "install":
		configs, _, settings, err := daemonConfig(context.Background())
		if err != nil {
			return err
		}
		if !settings.Enabled {
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
		if changed {
			if err := os.WriteFile(installed+".new", body, 0755); err != nil {
				return err
			}
			if err := os.Rename(installed+".new", installed); err != nil {
				return err
			}
		}
		var env strings.Builder
		for _, engine := range []string{"codex", "claude", "grok"} {
			cfg := configs[engine]
			if cfg == nil {
				continue
			}
			key := map[string]string{"codex": "CDX_CONFIG_PATH", "claude": "CLX_CONFIG_PATH", "grok": "CGX_CONFIG_PATH"}[engine]
			fmt.Fprintf(&env, "Environment=%s\n", systemdQuote(key+"="+cfg.SourcePath()))
		}
		unit := fmt.Sprintf("[Unit]\nDescription=Codex Orchestrator optional host daemon\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nUser=%s\nEnvironment=%s\n%sExecStart=%s daemon run\nRestart=on-failure\nRestartSec=5\nUMask=0077\nKillMode=control-group\nTimeoutStopSec=45\n[Install]\nWantedBy=multi-user.target\n", settings.Username, systemdQuote("HOME="+account.HomeDir), env.String(), systemdQuote(installed))
		unitChanged, err := writeProtectedFileIfChanged("/etc/systemd/system/cxx-daemon.service", []byte(unit))
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
		return runServiceProcess(stdout, stderr, "systemctl", verb, "cxx-daemon.service")
	default:
		return fmt.Errorf("unknown daemon action %q", action)
	}
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
	go func() { defer workers.Done(); runDaemonPeers(ctx, version, &activeMu, active, stderr) }()
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
	for ctx.Err() == nil {
		configs, client, settings, err := daemonConfig(ctx)
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
		if !settings.Enabled && count == 0 && len(pendingJournals) == 0 {
			return nil
		}
		if settings.Username != currentUserName() {
			return errors.New("configured daemon user differs from current user")
		}
		address := strings.Replace(strings.Replace(client.baseURL, "https://", "wss://", 1), "http://", "ws://", 1) + "/host/daemon/connect"
		wc, err := websocket.NewConfig(address, client.baseURL)
		if err != nil {
			return err
		}
		wc.Header.Set("X-API-Key", client.apiKey)
		wc.TlsConfig = client.http.Transport.(*http.Transport).TLSClientConfig
		ws, err := websocket.DialConfig(wc)
		if err != nil {
			if !retry() {
				break
			}
			continue
		}
		ws.MaxPayloadBytes = 2 * 1024 * 1024
		c := &daemonConnection{ws: ws, pending: map[string]chan daemonFrame{}, done: make(chan struct{})}
		connectionMu.Lock()
		connection = c
		connectionMu.Unlock()
		incoming := make(chan daemonOperation, 64)
		go func() {
			defer close(c.done)
			for {
				var frame daemonFrame
				if websocket.JSON.Receive(ws, &frame) != nil {
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
		err = c.rpc(ctx, "hello", map[string]any{"instance_id": instance, "username": settings.Username, "version": version, "engines": engines, "error": nil}, nil)
		if err != nil {
			ws.Close()
			if !retry() {
				break
			}
			continue
		}
		fmt.Fprintln(stdout, "host daemon connected")
		replayDaemonPeerReceipts(ctx, client)
		// An accepted launch found after process restart is ambiguous, never replayed.
		files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
		for _, path := range files {
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
		ticker := time.NewTicker(15 * time.Second)
	loop:
		for {
			select {
			case <-ctx.Done():
				break loop
			case <-c.done:
				break loop
			case op := <-incoming:
				activeMu.Lock()
				_, running := active[op.Session]
				activeMu.Unlock()
				if running {
					continue
				}
				if _, err := os.Stat(filepath.Join(dir, op.ID+".json")); err == nil {
					continue
				}
				j := daemonJournal{Operation: op}
				if err := saveDaemonJournal(dir, j); err != nil {
					fmt.Fprintln(stderr, "daemon journal:", err)
					continue
				}
				if err := c.rpc(ctx, "accept", map[string]any{"operation_id": op.ID, "claim_id": op.Claim}, nil); err != nil {
					var rejected *daemonRejection
					if errors.As(err, &rejected) {
						_ = os.Remove(filepath.Join(dir, op.ID+".json"))
					} else {
						_ = ws.Close()
					}
					continue
				}
				runCtx, stop := context.WithCancel(ctx)
				activeMu.Lock()
				active[op.Session] = stop
				activeMu.Unlock()
				workers.Add(1)
				go func() {
					defer workers.Done()
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
					stop()
				}()
			case <-ticker.C:
				replayDaemonPeerReceipts(ctx, client)
				if refreshed, _, _, e := daemonConfig(ctx); e == nil {
					configs = refreshed
					engines = daemonReadyEngines(configs)
				}
				var heartbeat struct {
					Settings daemonSettings `json:"settings"`
					Stop     []string       `json:"stop"`
				}
				if err := c.rpc(ctx, "heartbeat", map[string]any{"engines": engines, "error": nil}, &heartbeat); err != nil {
					break loop
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
				if !heartbeat.Settings.Enabled && count == 0 && len(pendingJournals) == 0 {
					ticker.Stop()
					ws.Close()
					return nil
				}
				// Retry receipts without rerunning the native process.
				files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
				for _, path := range files {
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
	args := nativeArgs(op.Engine, op.Upstream)
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
	cmd.Env = append(os.Environ(), "CXX_DAEMON_OPERATION_ID="+op.ID, "CXX_DAEMON_CLAIM_ID="+op.Claim)
	if op.Address != "" {
		cmd.Env = append(cmd.Env, "CXX_AGENT_MESSAGING_ADDRESS="+op.Address, "CXX_AGENT_MESSAGING_BINDING_GENERATION="+strconv.Itoa(op.Generation), "CXX_AGENT_MESSAGING_CONTINUITY=native", "CXX_AGENT_MESSAGING_UPSTREAM_SESSION_ID="+op.Upstream)
	}
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
		return daemonResult{Status: "failed", Reply: "Native process exited unsuccessfully; inspect the native session on the host", Upstream: upstream}
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
	work, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	peers, _ := filepath.Glob(filepath.Join(dir, "receipts", "*.json"))
	return append(work, peers...)
}

package agentbus

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/httpguard"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipv4"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeprocess"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

const (
	relayHeartbeatEvery = 20 * time.Second
	deliveryRenewEvery  = 20 * time.Second
	workerOutputLimit   = 2 << 20
)

type relayRegistration struct {
	RelayID     string `json:"relay_id"`
	Generation  int    `json:"generation"`
	RelayToken  string `json:"relay_token"`
	ExpiresAt   string `json:"expires_at"`
	PollSeconds int    `json:"poll_seconds"`
}

type relayClaim struct {
	Delivery *relayDelivery `json:"delivery"`
}

type relayDelivery struct {
	ExecutionContractVersion int            `json:"execution_contract_version"`
	WorkKind                 string         `json:"work_kind"`
	MessageID                string         `json:"message_id"`
	ConversationID           string         `json:"conversation_id"`
	Sequence                 int64          `json:"sequence"`
	ReplyToMessageID         *string        `json:"reply_to_message_id"`
	Kind                     string         `json:"kind"`
	Content                  string         `json:"content"`
	Sender                   map[string]any `json:"sender"`
	Target                   map[string]any `json:"target"`
	Attempts                 int            `json:"attempts"`
	ClaimID                  string         `json:"claim_id"`
	LeaseUntil               string         `json:"lease_until"`
	ExpiresAt                string         `json:"expires_at"`
}

type relayClient struct {
	connectionOwned      atomic.Bool
	stateProtocol        int
	daemon               bool
	claimPermit          func() (func(), bool)
	beforeDelivery       func(context.Context, *relayDelivery) (context.Context, func())
	baseURL              string
	apiKey               string
	http                 *http.Client
	id                   string
	instanceID           string
	generation           int
	token                string
	heartbeatEvery       time.Duration
	completionRenewEvery time.Duration
}

type nativeResult struct {
	Reply             string
	UpstreamSessionID string
	Started           bool
	MissingTranscript bool
	Capacity          bool
	RetryNotBefore    string
	Err               error
}

var startNativeCommand = func(cmd *exec.Cmd) error { return cmd.Start() }

var runNativeAdapter = func(c *relayClient, ctx context.Context, cfg *config.Config, delivery *relayDelivery, upstream string, alreadyAccepted bool) nativeResult {
	return c.runNative(ctx, cfg, delivery, upstream, alreadyAccepted)
}

// RunWorker runs the per-user background worker. The auth watcher remains
// local until credentials change or a managed child is active; the optional
// relay never opens a listener
// and persists only opaque IDs needed for reconnect/idempotency.
func RunWorker(parent context.Context, version string, stdout, stderr io.Writer) error {
	ctx, stop := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer stop()
	// The worker itself enforces docs/host-runtime-policy.md before it watches,
	// leases or relays anything: an older API does not refuse a relay, and a
	// legacy unit can still start a new binary on a normal host.
	switch awaitWorkerPolicy(ctx, stderr) {
	case workerForbidden:
		fmt.Fprintln(stdout, "cxx background worker: host is not persistent; exiting")
		return nil
	case workerStaleConfig:
		fmt.Fprintln(stdout, "cxx background worker: signed config stays unusable (unreadable or expired); exiting")
		return nil
	case workerUnknown:
		return nil // context ended while the answer was still unknown
	}
	ctx, revoke := context.WithCancel(ctx)
	defer revoke()
	// The policy watcher and the auth watchers are awaited before RunWorker
	// returns: none of them may outlive the worker (feedback eabea103).
	var policyWatchDone, authWatchDone sync.WaitGroup
	policyWatchDone.Add(1)
	go func() { defer policyWatchDone.Done(); watchWorkerPolicy(ctx, revoke, stderr) }()
	for _, engine := range []string{config.EngineCodex, config.EngineClaude, config.EngineGrok} {
		authWatchDone.Add(1)
		go func() { defer authWatchDone.Done(); runPersistentAuthWatch(ctx, engine, slog.Default()) }()
	}
	defer func() { stop(); authWatchDone.Wait(); policyWatchDone.Wait() }()
	// A new worker process is a new lease owner. A durable installation UUID
	// must never authorize taking over a predecessor's unresolved work.
	instanceID := newUUID()
	fmt.Fprintln(stdout, "cxx background worker: starting")
	var stale staleConfigClock
	for ctx.Err() == nil {
		configs, seed, err := workerLoadConfigs()
		if err != nil || seed == nil {
			if err != nil {
				fmt.Fprintln(stderr, "agent messaging relay: signed config unavailable:", err)
			}
			if stale.observe(configPermanentlyUnusable(err), time.Now()) {
				// Feedback 845ba7f6: a config that stays unreadable (a root-owned
				// layout) or expired never heals for this worker. Exit 0 so
				// Restart=on-failure leaves it down; maintenance starts it again
				// once a usable config is back on a persistent host.
				fmt.Fprintln(stdout, "cxx background worker: signed config stays unusable (unreadable or expired); exiting")
				break
			}
			if !waitContext(ctx, workerConfigRetry) {
				break
			}
			continue
		}
		stale.observe(false, time.Now())
		client, err := newRelayClient(seed)
		if err != nil {
			return err
		}
		username, err := workerUsername()
		if err != nil {
			return err
		}
		registration, err := client.register(ctx, username, instanceID, version)
		if err != nil {
			if relayNotPersistent(err) {
				// Only a persistent host may run a relay (docs/host-runtime-policy.md).
				// Exit cleanly: Restart=on-failure does not bring the unit back, and the
				// next maintenance run retires it.
				fmt.Fprintln(stderr, "agent messaging relay: this host is not persistent; background worker exits")
				break
			}
			if !waitContext(ctx, retryDelay(err)) {
				break
			}
			continue
		}
		client.id, client.token = registration.RelayID, registration.RelayToken
		fmt.Fprintln(stdout, "agent messaging relay: connected")
		err = client.poll(ctx, configs, stderr)
		stopCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = client.stop(stopCtx)
		cancel()
		if ctx.Err() != nil {
			break
		}
		if relayNotPersistent(err) {
			fmt.Fprintln(stderr, "agent messaging relay: this host is no longer persistent; background worker exits")
			break
		}
		if err != nil {
			fmt.Fprintln(stderr, "agent messaging relay: reconnecting:", sanitizedError(err))
		}
		if !waitContext(ctx, reconnectDelay(err)) {
			break
		}
	}
	fmt.Fprintln(stdout, "cxx background worker: stopped")
	return nil
}

func loadMessagingConfigs() (map[string]*config.Config, *config.Config, error) {
	pubkey, err := signing.PublicKey()
	if err != nil {
		return nil, nil, err
	}
	loaded := map[string]*config.Config{}
	var loadErrors []error
	for _, engine := range []string{config.EngineCodex, config.EngineClaude, config.EngineGrok} {
		path, pathErr := config.DefaultPathForEngine(engine)
		if pathErr != nil {
			loadErrors = append(loadErrors, pathErr)
			continue
		}
		cfg, loadErr := config.LoadForEngine(path, pubkey, false, engine)
		if loadErr != nil {
			if !errors.Is(loadErr, os.ErrNotExist) {
				loadErrors = append(loadErrors, fmt.Errorf("%s: %w", engine, loadErr))
			}
			continue
		}
		// A fleet-suspended engine stops receiving. The server also stops
		// baking its messaging block; this keeps a lagging config honest.
		if !cfg.AgentMessaging.Enabled || cfg.EngineSuspended(engine) {
			continue
		}
		loaded[engine] = cfg
	}
	var seed *config.Config
	for _, engine := range []string{config.EngineCodex, config.EngineClaude, config.EngineGrok} {
		if loaded[engine] != nil {
			seed = loaded[engine]
			break
		}
	}
	if seed == nil {
		if len(loadErrors) > 0 {
			return loaded, nil, errors.Join(loadErrors...)
		}
		return loaded, nil, nil
	}
	for engine, cfg := range loaded {
		if cfg.Host.ID != seed.Host.ID || cfg.Host.FQDN != seed.Host.FQDN || cfg.Orchestrator.BaseURL != seed.Orchestrator.BaseURL || cfg.Orchestrator.InstallationID != seed.Orchestrator.InstallationID {
			return nil, nil, fmt.Errorf("%s signed config does not match relay host identity", engine)
		}
	}
	return loaded, seed, nil
}

// errRelayConfigRefused marks a signed config that can never run a relay (plain
// HTTP to a remote server, or TLS verification bypassed). It is permanent for
// that config, so a worker must not wait or restart for it (feedback 42fe1081).
var errRelayConfigRefused = errors.New("agent messaging relay")

func newRelayClient(cfg *config.Config) (*relayClient, error) {
	if cfg == nil {
		return nil, errors.New("relay config is nil")
	}
	parsed, err := url.Parse(cfg.Orchestrator.BaseURL)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && (parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "localhost" || parsed.Hostname() == "::1")) {
		return nil, fmt.Errorf("%w: requires HTTPS (HTTP is allowed only on loopback)", errRelayConfigRefused)
	}
	if cfg.Orchestrator.AllowInsecure {
		return nil, fmt.Errorf("%w: refuses TLS verification bypass", errRelayConfigRefused)
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.Orchestrator.CABundlePath != nil && strings.TrimSpace(*cfg.Orchestrator.CABundlePath) != "" {
		pem, err := os.ReadFile(strings.TrimSpace(*cfg.Orchestrator.CABundlePath))
		if err != nil {
			return nil, fmt.Errorf("read CA bundle: %w", err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("CA bundle contains no certificates")
		}
		tlsConfig.RootCAs = pool
	}
	transport := &http.Transport{DialContext: ipv4.PreferDialContext(), TLSClientConfig: tlsConfig, MaxIdleConns: 4, IdleConnTimeout: 45 * time.Second, ResponseHeaderTimeout: 35 * time.Second}
	return &relayClient{
		baseURL: strings.TrimRight(cfg.Orchestrator.BaseURL, "/"), apiKey: cfg.Orchestrator.APIKey,
		stateProtocol: cfg.Orchestrator.CommunicatorStateProtocol,
		http:          &http.Client{Transport: communicator.Wrap(transport), Timeout: 40 * time.Second, CheckRedirect: httpguard.Redirect},
	}, nil
}

func (c *relayClient) register(ctx context.Context, username, instanceID, version string) (*relayRegistration, error) {
	var out relayRegistration
	capabilities := map[string]any{"host_daemon": c.daemon, "execution_contract_version": 2, "watchdog_protocol_version": 1, "supervisor_protocol_version": 1, "headless": true, "codex_exec_resume": true, "claude_print_resume": true, "grok_json_resume": true}
	if c.stateProtocol == 1 {
		capabilities["control_state_protocol"] = 1
	}
	err := doJSON(ctx, c.http, c.baseURL, http.MethodPost, "/host/agent-relays/register", map[string]any{
		"username": username, "instance_id": instanceID, "wrapper_version": version,
		"capabilities": capabilities,
	}, map[string]string{"X-API-Key": c.apiKey}, &out)
	if err != nil {
		return nil, err
	}
	if out.RelayID == "" || out.RelayToken == "" {
		return nil, errors.New("relay registration returned incomplete credential")
	}
	c.instanceID, c.generation = instanceID, out.Generation
	return &out, nil
}

func (c *relayClient) poll(ctx context.Context, configs map[string]*config.Config, stderr io.Writer) error {
	return c.pollParallel(ctx, configs, stderr, 1)
}

// pollParallel runs one heartbeat for this registration and `loops` claim loops
// sharing it. The daemon used to call poll once per parallel slot, so every
// interval sent max_parallel identical heartbeats for one relay.
func (c *relayClient) pollParallel(ctx context.Context, configs map[string]*config.Config, stderr io.Writer, loops int) (resultErr error) {
	if loops < 1 {
		loops = 1
	}
	state, stateErr := communicator.DialState(ctx, c.baseURL, communicator.StateScope{Topic: "relay", RelayID: c.id, NativeInstanceID: c.instanceID, BindingGeneration: c.generation}, communicator.StateAuth{RelayToken: c.token})
	if stateErr == nil {
		c.connectionOwned.Store(true)
		return c.pollState(ctx, configs, stderr, loops, state)
	}
	if c.connectionOwned.Load() || c.stateProtocol == 1 || communicator.StateRequired(c.baseURL) {
		return stateErr
	}
	pollCtx, cancel := context.WithCancel(ctx)
	heartbeatErr := make(chan error, 1)
	heartbeatDone := make(chan struct{})
	interval := c.heartbeatEvery
	if interval <= 0 || interval > 30*time.Second {
		interval = relayHeartbeatEvery
	}
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-pollCtx.Done():
				return
			case <-ticker.C:
				if err := c.heartbeat(pollCtx); err != nil {
					select {
					case heartbeatErr <- err:
					default:
					}
					cancel()
					return
				}
			}
		}
	}()
	defer func() {
		cancel()
		<-heartbeatDone
		select {
		case err := <-heartbeatErr:
			if resultErr == nil || errors.Is(resultErr, context.Canceled) {
				resultErr = err
			}
		default:
		}
	}()

	// Slots are elastic. An idle relay holds one long poll instead of `loops`
	// identical ones, each of which the server re-checked on its idle grid.
	// Every claimed delivery opens one more slot, up to `loops`; a burst slot
	// closes again after its first empty claim.
	loopErr := make(chan error, loops)
	var loopsDone sync.WaitGroup
	var slotsMu sync.Mutex
	active := 0
	var start func(primary bool)
	start = func(primary bool) {
		slotsMu.Lock()
		if active >= loops {
			slotsMu.Unlock()
			return
		}
		active++
		slotsMu.Unlock()
		loopsDone.Add(1)
		go func() {
			defer loopsDone.Done()
			err := c.claimLoop(pollCtx, configs, stderr, primary, func() { start(false) })
			slotsMu.Lock()
			active--
			slotsMu.Unlock()
			if primary || err != nil {
				select {
				case loopErr <- err:
				default:
				}
				cancel()
			}
		}()
	}
	start(true)
	loopsDone.Wait()
	close(loopErr)
	for err := range loopErr {
		if err != nil && (resultErr == nil || errors.Is(resultErr, context.Canceled)) {
			resultErr = err
		}
	}
	return resultErr
}

// claimLoop claims until the poll ends. A burst slot (keep false) returns after
// its first empty claim; burst opens another slot before a delivery runs.
func (c *relayClient) claimLoop(pollCtx context.Context, configs map[string]*config.Config, stderr io.Writer, keep bool, burst func()) error {
	for pollCtx.Err() == nil {
		finish := func() {}
		if c.claimPermit != nil {
			var allowed bool
			finish, allowed = c.claimPermit()
			if !allowed {
				if !keep {
					return nil
				}
				if !waitContext(pollCtx, time.Second) {
					return pollCtx.Err()
				}
				continue
			}
		}
		claimID := newUUID()
		var claim relayClaim
		if err := c.relayPost(pollCtx, "/deliveries/claim", map[string]any{"claim_id": claimID, "wait_seconds": 25}, &claim); err != nil {
			finish()
			return err
		}
		if claim.Delivery == nil {
			finish()
			if !keep {
				return nil
			}
			continue
		}
		if burst != nil {
			burst()
		}
		if err := c.processDelivery(pollCtx, configs, claim.Delivery); err != nil {
			fmt.Fprintln(stderr, "agent messaging delivery", opaqueID(claim.Delivery.MessageID)+":", sanitizedError(err))
		}
		finish()
	}
	return pollCtx.Err()
}

func (c *relayClient) processDelivery(ctx context.Context, configs map[string]*config.Config, delivery *relayDelivery) error {
	if c.beforeDelivery != nil {
		var finish func()
		ctx, finish = c.beforeDelivery(ctx, delivery)
		defer finish()
	}
	if delivery.Kind == "presence_notice" {
		return c.ack(ctx, delivery, "dead", "presence_notice_live_session_only", nil)
	}
	engine := stringArg(delivery.Target, "engine")
	cfg := configs[engine]
	if cfg == nil {
		return c.ack(ctx, delivery, "retry", "engine_config_unavailable", nil)
	}
	upstream := stringArg(delivery.Target, "upstream_session_id")
	if stringArg(delivery.Target, "continuity") != "native" {
		upstream = ""
	}
	if stringArg(delivery.Target, "watchdog_id") != "" {
		deadline, err := time.Parse(time.RFC3339Nano, stringArg(delivery.Target, "watchdog_deadline_at"))
		if err != nil || !deadline.After(time.Now()) || upstream == "" || upstream != stringArg(delivery.Target, "watchdog_native_session_id") {
			return c.ack(ctx, delivery, "dead", "watchdog_recovery_unavailable", nil)
		}
	}
	lockKey := upstream
	if lockKey == "" {
		lockKey = stringArg(delivery.Target, "address")
	}
	lockPath, err := writerLockPath(engine, lockKey)
	if err != nil {
		return err
	}
	lock, err := ipc.TryAcquireExclusivePath(lockPath)
	if errors.Is(err, ipc.ErrHeld) {
		return c.ack(ctx, delivery, "retry", "native_session_busy", nil)
	}
	if err != nil {
		return err
	}
	defer lock.Release()

	if delivery.Kind == "schedule" && (upstream == "" || !boolArg(delivery.Target, "schedule_persistent")) {
		return c.ack(ctx, delivery, "dead", "schedule_transcript_missing", nil)
	}
	if boolArg(delivery.Target, "fresh_start_approved") && delivery.Kind != "schedule" {
		upstream = ""
	}
	if delivery.WorkKind != "" && upstream == "" && !boolArg(delivery.Target, "fresh_start_approved") && delivery.Kind != "schedule" {
		return c.ack(ctx, delivery, "dead", "native_transcript_missing", nil)
	}
	result := runNativeAdapter(c, ctx, cfg, delivery, upstream, false)

	if result.Err != nil || result.Capacity || result.MissingTranscript || (delivery.WorkKind == "" && strings.TrimSpace(result.Reply) == "") {
		outcome := "retry"
		if result.Started {
			outcome = "ambiguous"
		}
		code := "native_start_failed"
		if result.Started {
			code = "native_outcome_ambiguous"
		}
		if result.MissingTranscript {
			outcome, code = "dead", "native_transcript_missing"
		}
		if delivery.Kind == "schedule" {
			if result.MissingTranscript {
				outcome, code = "dead", "schedule_transcript_missing"
			} else if result.Capacity {
				code = "schedule_capacity"
			}
		}
		_ = c.ack(ctx, delivery, outcome, code, &result)
		if result.Err != nil {
			return result.Err
		}
		return errors.New("native agent returned no final response")
	}
	if (delivery.Kind == "reply" || delivery.Kind == "publication") && strings.TrimSpace(result.Reply) == noReplyMarker(delivery) {
		return c.ack(ctx, delivery, "completed", "", &result)
	}
	var report *taskResult
	if delivery.WorkKind != "" {
		result.Reply, report = parseTaskOutput(result.Reply)
		if strings.TrimSpace(result.Reply) == "" {
			result.Reply = "No explicit final response was returned."
		}
	}
	if delivery.Kind == "schedule" {
		return c.completeTask(ctx, delivery, report, &result)
	}
	reply := truncateUTF8(result.Reply, maxBodyBytes)
	var replyOut map[string]any
	replyBody := map[string]any{"claim_id": delivery.ClaimID, "content": reply, "client_message_id": newUUID(), "upstream_session_id": emptyToNil(result.UpstreamSessionID)}
	if report != nil {
		replyBody["task_result"] = report
	}
	if err := c.storeCompletion(ctx, delivery, "/deliveries/"+url.PathEscape(delivery.MessageID)+"/reply", replyBody, &replyOut); err != nil {
		_ = c.ack(ctx, delivery, "ambiguous", "reply_store_ambiguous", &result)
		return err
	}
	return c.ack(ctx, delivery, "completed", "", &result)
}

func (c *relayClient) runNative(ctx context.Context, cfg *config.Config, delivery *relayDelivery, upstream string, alreadyAccepted bool) nativeResult {
	result := nativeResult{}
	exe, err := os.Executable()
	if err != nil {
		result.Err = err
		return result
	}
	engine := stringArg(delivery.Target, "engine")
	if engine == config.EngineGrok && upstream != "" {
		if err := checkGrokTranscript(upstream); err != nil {
			result.Err = err
			result.MissingTranscript = errors.Is(err, errNativeTranscriptMissing)
			return result
		}
	}
	args := nativeArgs(engine, upstream, stringArg(delivery.Target, "daemon_model"))
	prompt := peerPrompt(delivery)
	if delivery.WorkKind != "" {
		prompt += "\n" + taskOutputInstruction
	}
	if engine == config.EngineGrok {
		file, err := os.CreateTemp("", "cxx-grok-delivery-*.txt")
		if err != nil {
			result.Err = err
			return result
		}
		defer os.Remove(file.Name())
		if err := file.Chmod(0o600); err != nil {
			file.Close()
			result.Err = err
			return result
		}
		if _, err := file.WriteString(prompt); err != nil {
			file.Close()
			result.Err = err
			return result
		}
		if err := file.Close(); err != nil {
			result.Err = err
			return result
		}
		args = append(args, "--prompt-file", file.Name())
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(runCtx, exe, args...)
	managed := stringArg(delivery.Target, "daemon_session_id") != ""
	var supervisor *nativeprocess.Supervisor
	if managed {
		cmd = exec.Command(exe, args...)
		prepareDaemonProcess(cmd)
	} else {
		// Allow the inner wrapper's ten-second native shutdown to finish before
		// forcing this wrapper down. Keep the writer lease until group cleanup.
		supervisor = nativeprocess.PrepareWithGrace(runCtx, cmd, true, 2*nativeprocess.Grace)
		defer supervisor.Close()
	}
	cmd.Dir = stringArg(delivery.Target, "cwd")
	cmd.Stdin = strings.NewReader(prompt)
	if engine == config.EngineGrok {
		cmd.Stdin = nil
	}
	var output tailBuffer
	var diagnostic tailBuffer
	output.limit, diagnostic.limit = workerOutputLimit, 256*1024
	cmd.Stdout, cmd.Stderr = &output, &diagnostic
	startupFile, _ := os.CreateTemp("", "cxx-native-startup-*.json")
	startupPath := ""
	if startupFile != nil {
		startupPath = startupFile.Name()
		defer os.Remove(startupPath)
		defer startupFile.Close()
	}
	cmd.Env = append(os.Environ(),
		agentportal.StartupFailureEnv+"="+startupPath,
		"CXX_AGENT_MESSAGING_ADDRESS="+stringArg(delivery.Target, "address"),
		"CXX_AGENT_MESSAGING_BINDING_GENERATION="+strconv.Itoa(intArg(delivery.Target, "binding_generation", 0)),
		"CXX_AGENT_MESSAGING_CONTINUITY="+map[bool]string{true: "native", false: "reset"}[upstream != ""],
		"CXX_AGENT_MESSAGING_UPSTREAM_SESSION_ID="+upstream,
		"CXX_AGENT_MESSAGING_MESSAGE_ID="+delivery.MessageID,
		"CXX_AGENT_MESSAGING_CLAIM_ID="+delivery.ClaimID,
	)
	if !alreadyAccepted {
		if err := c.ack(ctx, delivery, "accepted", "", nil); err != nil {
			result.Err = fmt.Errorf("accept delivery: %w", err)
			return result
		}
	}
	if err := startNativeCommand(cmd); err != nil {
		result.Err = err
		_ = c.ack(ctx, delivery, "dead", "native_start_failed_after_accept", nil)
		return result
	}
	result.Started = true
	renewErr := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if c.connectionOwned.Load() {
			<-runCtx.Done()
			return
		}
		ticker := time.NewTicker(deliveryRenewEvery)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				if err := c.renew(runCtx, delivery); err != nil {
					select {
					case renewErr <- err:
					default:
					}
					cancel()
					return
				}
			}
		}
	}()
	var waitErr error
	if managed {
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case waitErr = <-done:
		case <-runCtx.Done():
			stopDaemonProcess(cmd, done)
			waitErr = runCtx.Err()
		}
	} else {
		waitErr = cmd.Wait()
		supervisor.Close()
	}
	cancel()
	<-done
	select {
	case err := <-renewErr:
		result.Err = fmt.Errorf("delivery revoked while native agent was running: %w", err)
		return result
	default:
	}
	if waitErr != nil {
		result.RetryNotBefore = scheduleRetryAt(output.String(), time.Now())
		result.MissingTranscript = isMissingTranscript(output.String() + "\n" + diagnostic.String())
		text := strings.ToLower(output.String() + "\n" + diagnostic.String())
		result.Capacity = strings.Contains(text, "at capacity") || strings.Contains(text, "rate_limit") || strings.Contains(text, "usage limit") || strings.Contains(text, "quota limit") || strings.Contains(text, "overloaded")
		result.Err = fmt.Errorf("native %s exited unsuccessfully", engine)
		if startupFile != nil {
			if diagnostic := agentportal.ReadStartupFailure(startupFile); diagnostic != "" {
				result.Err = fmt.Errorf("native %s exited unsuccessfully: %s", engine, diagnostic)
			}
		}
		return result
	}
	text := strings.ToLower(output.String() + "\n" + diagnostic.String())
	result.Capacity = strings.Contains(text, "at capacity") || strings.Contains(text, "rate_limit") || strings.Contains(text, "usage limit") || strings.Contains(text, "quota limit") || strings.Contains(text, "overloaded")
	result.RetryNotBefore = scheduleRetryAt(output.String(), time.Now())
	result.Reply, result.UpstreamSessionID = parseNativeOutput(engine, output.Bytes())
	if strings.TrimSpace(result.Reply) != "" {
		result.Capacity = false
	}
	return result
}

func nativeArgs(engine, upstream string, model ...string) []string {
	// Keep wrapper lifecycle/auth/sync supervision while leaving stdout as the
	// native machine-readable response. Boot/footer rendering would corrupt the
	// single JSON document returned by Claude's print mode.
	args := []string{engine, "--skip-boot", "run"}
	// A session-pinned model (Fleet Advisor) is passed on every turn, first and
	// resumed. An explicit flag also wins over the host's model override.
	pinned := ""
	if len(model) > 0 {
		pinned = strings.TrimSpace(model[0])
	}
	if engine == config.EngineCodex {
		if pinned != "" {
			args = append(args, "--model", pinned)
		}
		args = append(args, "exec")
		if upstream != "" {
			return append(args, "resume", "--json", "--skip-git-repo-check", upstream, "-")
		}
		return append(args, "--json", "--skip-git-repo-check", "-")
	}
	if engine == config.EngineGrok {
		args = append(args, "--no-leader", "--output-format", "json")
		if pinned != "" {
			args = append(args, "--model", pinned)
		}
		if upstream != "" {
			args = append(args, "--resume", upstream)
		}
		return args
	}
	if upstream != "" {
		// Use the wrapper's resume subcommand. Passing --resume after `run`
		// would be consumed as a wrapper-owned flag and turn the preceding `run`
		// token into native prompt text.
		args = append(args[:2], "resume", upstream, "-p", "--output-format", "json")
	} else {
		args = append(args, "-p", "--output-format", "json")
	}
	if pinned != "" {
		args = append(args, "--model", pinned)
	}
	return args
}

func (c *relayClient) relayPost(ctx context.Context, suffix string, body any, out any) error {
	return doJSON(ctx, c.http, c.baseURL, http.MethodPost, "/host/agent-relays/"+url.PathEscape(c.id)+suffix, body, map[string]string{"X-Agent-Relay-Token": c.token}, out)
}

func (c *relayClient) heartbeat(ctx context.Context) error {
	var out map[string]any
	return c.relayPost(ctx, "/heartbeat", map[string]any{}, &out)
}

func (c *relayClient) renew(ctx context.Context, delivery *relayDelivery) error {
	if c.connectionOwned.Load() {
		return nil
	}
	var out map[string]any
	return c.relayPost(ctx, "/deliveries/"+url.PathEscape(delivery.MessageID)+"/renew", map[string]any{"claim_id": delivery.ClaimID}, &out)
}

func (c *relayClient) ack(ctx context.Context, delivery *relayDelivery, outcome, code string, result *nativeResult) error {
	body := map[string]any{"claim_id": delivery.ClaimID, "outcome": outcome}
	if code != "" {
		body["error_code"] = code
	}
	if result != nil && result.RetryNotBefore != "" {
		body["error"] = "retry_not_before=" + result.RetryNotBefore
	}
	if result != nil && result.UpstreamSessionID != "" {
		body["upstream_session_id"] = result.UpstreamSessionID
	}
	var out map[string]any
	err := c.relayPost(ctx, "/deliveries/"+url.PathEscape(delivery.MessageID)+"/ack", body, &out)
	if err != nil && outcome == "accepted" {
		err = c.relayPost(ctx, "/deliveries/"+url.PathEscape(delivery.MessageID)+"/ack", body, &out)
	}
	if err != nil {
		return err
	}
	if outcome == "accepted" {
		message, _ := out["message"].(map[string]any)
		if stringArg(message, "status") != "accepted" {
			return errors.New("delivery acceptance was not confirmed")
		}
	}
	return nil
}

func (c *relayClient) storeCompletion(ctx context.Context, delivery *relayDelivery, suffix string, body any, out any) error {
	// Native execution has finished, but its result still belongs to this claim.
	// Keep that lease alive through slow storage and lost-response retries. The
	// native runner's renewal loop ends when its child exits.
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	every := c.completionRenewEvery
	if every <= 0 {
		every = deliveryRenewEvery
	}
	go func() {
		defer close(done)
		if c.connectionOwned.Load() {
			<-ctx.Done()
			return
		}
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := c.renew(ctx, delivery); definitiveChannelRenewalError(err) {
					// Completion may already be stored with its response lost. Stop
					// renewing, but let the idempotent storage call confirm that result.
					return
				}
			}
		}
	}()
	defer func() { cancel(); <-done }()
	for {
		err := c.relayPost(ctx, suffix, body, out)
		if err == nil {
			return nil
		}
		var apiErr *APIError
		if errors.As(err, &apiErr) && (apiErr.Status == 400 || apiErr.Status == 401 || apiErr.Status == 403 || apiErr.Status == 404 || apiErr.Status == 409 || apiErr.Status == 422) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func (c *relayClient) completeTask(ctx context.Context, delivery *relayDelivery, report *taskResult, result *nativeResult) error {
	if delivery.WorkKind == "" {
		return c.ack(ctx, delivery, "completed", "", result)
	}
	if report == nil {
		report = unknownResult()
	}
	body := map[string]any{"claim_id": delivery.ClaimID, "outcome": "completed", "task_result": report, "upstream_session_id": emptyToNil(result.UpstreamSessionID)}
	var out map[string]any
	return c.storeCompletion(ctx, delivery, "/deliveries/"+url.PathEscape(delivery.MessageID)+"/ack", body, &out)
}

func (c *relayClient) stop(ctx context.Context) error {
	if c.id == "" || c.token == "" {
		return nil
	}
	var out map[string]any
	return c.relayPost(ctx, "/stop", map[string]any{}, &out)
}

func peerPrompt(delivery *relayDelivery) string {
	if delivery.Kind == "schedule" {
		return "Stored Wake/Cron instruction from the schedule creator. Preserve existing permission boundaries. Continue the same native session; do not send a peer acknowledgement.\n" + delivery.Content
	}

	payload, _ := json.Marshal(map[string]any{
		"message_id":      delivery.MessageID,
		"conversation_id": delivery.ConversationID,
		"kind":            delivery.Kind,
		"sender":          stringArg(delivery.Sender, "address"),
		"content":         delivery.Content,
	})
	response := "Return a concise final response for the sender; the relay will correlate it automatically."
	if delivery.Kind == "reply" || delivery.Kind == "publication" {
		response = "This is a peer reply, informational by default. "
		if delivery.Kind == "publication" {
			response = "This is an informational publication; no reply is required. "
		}
		response += "Do not acknowledge an acknowledgement or answer a closing acknowledgement. Continue only for an explicit question, requested work, or a substantive next turn in an active call. If no answer is needed, return exactly " + noReplyMarker(delivery) + " as your final response; the relay completes the delivery without sending another message. Otherwise return a concise final response for the sender; the relay will correlate it automatically."
	}
	return peerDeliveryGuidance(delivery.Kind) + " " + response + "\n\nDelivery JSON:\n" + string(payload)
}

func noReplyMarker(delivery *relayDelivery) string {
	return "CXX_AGENT_NO_REPLY:" + delivery.MessageID
}

func parseNativeOutput(engine string, raw []byte) (reply, sessionID string) {
	if engine == config.EngineGrok {
		var result struct {
			Text       string `json:"text"`
			SessionID  string `json:"sessionId"`
			Type       string `json:"type"`
			StopReason string `json:"stopReason"`
		}
		if json.Unmarshal(bytes.TrimSpace(raw), &result) == nil && result.Type != "error" && (result.StopReason == "end_turn" || result.StopReason == "refusal") {
			return result.Text, result.SessionID
		}
		return "", ""
	}
	if engine == config.EngineClaude {
		var result struct {
			Result    string `json:"result"`
			SessionID string `json:"session_id"`
			IsError   bool   `json:"is_error"`
			Subtype   string `json:"subtype"`
		}
		if json.Unmarshal(bytes.TrimSpace(raw), &result) == nil && !result.IsError && (result.Subtype == "" || result.Subtype == "success") {
			return result.Result, result.SessionID
		}
		return "", ""
	}
	failed := false
	for _, line := range bytes.Split(raw, []byte("\n")) {
		var event map[string]any
		if json.Unmarshal(line, &event) != nil {
			continue
		}
		if event["type"] == "thread.started" {
			sessionID = stringArg(event, "thread_id")
		}
		if event["type"] == "turn.failed" {
			failed = true
		}
		item, _ := event["item"].(map[string]any)
		if event["type"] == "item.completed" && stringArg(item, "type") == "agent_message" {
			reply = stringArg(item, "text")
		}
	}
	if failed {
		reply = ""
	}
	return reply, sessionID
}

func isMissingTranscript(text string) bool {
	lower := strings.ToLower(text)
	return strings.Contains(lower, "session") && (strings.Contains(lower, "not found") || strings.Contains(lower, "no rollout") || strings.Contains(lower, "does not exist") || strings.Contains(lower, "no conversation found"))
}

func loadOrCreateInstanceID() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".cxx", "agent")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "instance-id")
	if raw, err := os.ReadFile(path); err == nil {
		id := strings.TrimSpace(string(raw))
		if len(id) == 36 {
			if err := os.Chmod(path, 0o600); err != nil {
				return "", err
			}
			return id, nil
		}
	}
	id := newUUID()
	if err := writeProtectedFile(path, []byte(id+"\n")); err != nil {
		return "", err
	}
	return id, nil
}

func workerUsername() (string, error) {
	current, err := user.Current()
	if err == nil && strings.TrimSpace(current.Username) != "" {
		return current.Username, nil
	}
	if value := strings.TrimSpace(os.Getenv("USER")); value != "" {
		return value, nil
	}
	return "", errors.New("determine relay username")
}

func truncateUTF8(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	raw := []byte(value[:maxBytes])
	for len(raw) > 0 && !utf8.Valid(raw) {
		raw = raw[:len(raw)-1]
	}
	return string(raw)
}

// reconnectDelay is how long the relay waits before rebuilding its session
// after poll() returns. A poll that ended in a shut door or a spent request
// budget must back off exactly like a failed registration does: the previous
// flat 2s meant a rate-limited relay re-registered, re-claimed and re-stopped
// about three times every two seconds, which is what kept the budget spent and
// stopped it recovering on its own. A clean exit keeps the original 2s.
func reconnectDelay(err error) time.Duration {
	if err == nil {
		return 2 * time.Second
	}
	return retryDelay(err)
}

// relayNotPersistent reports the server's refusal of a per-user relay on a host
// without the persistent flag.
// workerPolicyRecheck is how often a running worker re-asks whether its host is
// still persistent; losing the flag ends the worker even against an API that
// does not refuse relays.
var workerPolicyRecheck = 5 * time.Minute

// awaitWorkerPolicy returns allowed or forbidden as soon as the server answers.
// While the answer is unknown (API unreachable) it waits without relaying.
// While the local signed config is unusable (unreadable or expired) it waits at
// most workerStaleConfigGrace, then reports workerStaleConfig.
func awaitWorkerPolicy(ctx context.Context, stderr io.Writer) workerDecision {
	var stale staleConfigClock
	for {
		decision := workerPolicy()
		if decision != workerUnknown && decision != workerStaleConfig {
			return decision
		}
		if stale.observe(decision == workerStaleConfig, time.Now()) {
			return workerStaleConfig
		}
		if decision == workerStaleConfig {
			fmt.Fprintln(stderr, "cxx background worker: signed config is unreadable or expired; waiting")
		} else {
			fmt.Fprintln(stderr, "cxx background worker: cannot confirm that this host is persistent; waiting")
		}
		if !waitContext(ctx, workerConfigRetry) {
			return workerUnknown
		}
	}
}

func watchWorkerPolicy(ctx context.Context, revoke context.CancelFunc, stderr io.Writer) {
	var stale staleConfigClock
	for waitContext(ctx, workerPolicyRecheck) {
		decision := workerPolicy()
		if decision == workerForbidden {
			fmt.Fprintln(stderr, "cxx background worker: host is no longer persistent; exiting")
			revoke()
			return
		}
		if stale.observe(decision == workerStaleConfig, time.Now()) {
			fmt.Fprintln(stderr, "cxx background worker: signed config stays unusable (unreadable or expired); exiting")
			revoke()
			return
		}
	}
}

// workerConfigRetry is how often an idle worker retries an unavailable config
// or an unanswered persistence check.
var workerConfigRetry = 30 * time.Second

// workerLoadConfigs is the worker loop's config loader (a seam for tests).
var workerLoadConfigs = loadMessagingConfigs

// workerStaleConfigGrace bounds how long a worker keeps running on a signed
// config that is unreadable (EACCES after the move to a root-owned layout) or
// expired. The grace lets a concurrent maintenance run refetch an expired
// config; past it the worker exits instead of logging every 30 seconds for
// weeks (feedback 845ba7f6).
var workerStaleConfigGrace = 5 * time.Minute

// staleConfigClock measures how long a config has been continuously unusable.
type staleConfigClock struct{ since time.Time }

// observe records one check and reports whether the grace is used up.
func (c *staleConfigClock) observe(unusable bool, now time.Time) bool {
	if !unusable {
		c.since = time.Time{}
		return false
	}
	if c.since.IsZero() {
		c.since = now
	}
	return now.Sub(c.since) >= workerStaleConfigGrace
}

// configPermanentlyUnusable reports a local signed config this process can
// never use as it stands: unreadable (permission) or expired. errors.Is walks
// the errors.Join built by loadMessagingConfigs.
func configPermanentlyUnusable(err error) bool {
	return err != nil && (errors.Is(err, os.ErrPermission) || errors.Is(err, config.ErrExpired))
}

func relayNotPersistent(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Code == "agent_messaging_relay_not_persistent"
}

func retryDelay(err error) time.Duration {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return 3 * time.Second
	}
	// Being rate limited is the one failure a 3-second retry actively makes
	// worse: every attempt spends more of the budget that is already gone, so
	// the relay keeps itself locked out. Honour the server's Retry-After when
	// it sent one, clamped so neither a tiny nor an absurd value gets through.
	if apiErr.Status == http.StatusTooManyRequests {
		if hint := apiErr.RetryAfter; hint > 0 {
			return min(max(hint, 5*time.Second), 5*time.Minute)
		}
		return 30 * time.Second
	}
	// A shut door, not a transient fault. An insecure host outside its allowed
	// window is refused for as long as the window stays closed, which is
	// minutes to hours; retrying every 3 seconds would make every such host
	// hammer the API and burn its own request-rate budget for nothing.
	// Uncertain relay ownership also requires reconciliation, not fast retries.
	switch {
	case apiErr.Code == "agent_messaging_disabled",
		apiErr.Code == "agent_messaging_insecure_window_closed",
		apiErr.Code == "agent_messaging_relay_uncertain",
		apiErr.Status == http.StatusServiceUnavailable:
		return 30 * time.Second
	}
	return 3 * time.Second
}

func waitContext(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func sanitizedError(err error) string {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		if apiErr.Code != "" {
			return apiErr.Code
		}
		return fmt.Sprintf("http_%d", apiErr.Status)
	}
	return err.Error()
}

func opaqueID(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

type tailBuffer struct {
	buf   []byte
	limit int
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	original := len(p)
	if b.limit <= 0 || len(p) == 0 {
		return original, nil
	}
	if len(p) >= b.limit {
		b.buf = append(b.buf[:0], p[len(p)-b.limit:]...)
		return original, nil
	}
	if overflow := len(b.buf) + len(p) - b.limit; overflow > 0 {
		copy(b.buf, b.buf[overflow:])
		b.buf = b.buf[:len(b.buf)-overflow]
	}
	b.buf = append(b.buf, p...)
	return original, nil
}

func (b *tailBuffer) Bytes() []byte  { return b.buf }
func (b *tailBuffer) String() string { return string(b.buf) }

var _ io.Writer = (*tailBuffer)(nil)

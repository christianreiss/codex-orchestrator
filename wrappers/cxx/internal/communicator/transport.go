// Package communicator shares the CoCo control connection between native lifecycles.
// Native provider traffic is never registered here.
package communicator

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

const Protocol = 1
const maxFrameBody = 640 * 1024

var registry sync.Map
var processContext = context.Background()

type endpoint struct {
	mu                 sync.Mutex
	jobs               map[string]syncJob
	syncProtocol       int
	runtimeOnly        bool
	base, path, socket string
	once               sync.Once
	leaseCancel        context.CancelFunc
	setupErr           error
	anchor             *config.Config
}

// sessionRuntimeRoot is the logind runtime directory that XDG_RUNTIME_DIR
// normally names. Tests replace it.
var sessionRuntimeRoot = func() string { return fmt.Sprintf("/run/user/%d", os.Getuid()) }

// runtimeRoot must resolve identically for every process of one user. Some
// launchers (Codex MCP servers, cron, non-login shells) drop XDG_RUNTIME_DIR;
// falling straight to /tmp there would elect a second owner and split the
// sync fences, so the logind directory is preferred whenever it exists.
func runtimeRoot() string {
	root, _ := runtimeRootSource()
	return root
}

// runtimeRootSource also names where the root came from ("XDG_RUNTIME_DIR",
// "logind" or "tmp") so status output can explain a missed owner.
func runtimeRootSource() (string, string) {
	if root := os.Getenv("XDG_RUNTIME_DIR"); root != "" {
		return root, "XDG_RUNTIME_DIR"
	}
	if root := sessionRuntimeRoot(); root != "" {
		if info, err := os.Lstat(root); err == nil && info.IsDir() && info.Mode().Perm() == 0700 {
			if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) == os.Getuid() {
				return root, "logind"
			}
		}
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("cxx-%d", os.Getuid())), "tmp"
}

// sun_path is 108 bytes on Linux and 104 on the BSDs and macOS, terminator included,
// so a bindable path is at most 107 / 103 bytes. Using each platform's own limit (not a
// shared conservative one) keeps every path that binds in its preferred place, where an
// owner of an older build may already be listening.
func socketPathLimit() int {
	switch runtime.GOOS {
	case "linux", "android":
		return 107
	default:
		return 103
	}
}

// executable is a seam for tests; production always re-executes itself.
var executable = os.Executable

const socketDirPrefix = "cxx-comm-"

// socketLength is the byte length of the socket under root.
func socketLength(root string) int {
	return len(filepath.Join(root, socketDirPrefix+"0123456789abcdef", "control.sock"))
}

// socketPath prefers the per-user runtime root. A root so deep that the socket would
// not bind (a long XDG_RUNTIME_DIR or TMPDIR) falls back to a short private directory
// under /tmp, keyed by that root as well as by the server so two distinct deep scopes
// (isolated test runs, harnesses) never share an owner, fence or credentials. The same
// scope and server always resolve to the same path in every process, and the fences and
// workers derive their locks from this path, so they stay with their owner.
func socketPath(base string) (string, error) {
	root := filepath.Clean(runtimeRoot())
	if err := checkPrivateDir(root, true); err != nil {
		// An unsafe or unusable root is a refusal, never a reason to look elsewhere.
		return "", err
	}
	if socketLength(root) <= socketPathLimit() {
		return socketPathIn(root, base, "")
	}
	short := filepath.Join("/tmp", fmt.Sprintf("cxx-%d", os.Getuid()))
	if err := checkPrivateDir(short, true); err != nil {
		return "", err
	}
	if socketLength(short) > socketPathLimit() {
		return "", errors.New("communicator socket path is too long for this platform")
	}
	return socketPathIn(short, base, root)
}

// checkPrivateDir verifies that dir (created 0700 if absent when create is set) is a
// real directory owned by this user with mode 0700.
func checkPrivateDir(dir string, create bool) error {
	if create {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() || !info.IsDir() || info.Mode().Perm() != 0700 {
		return errors.New("unsafe communicator runtime root")
	}
	return nil
}

// socketPathIn places the per-server directory under an already verified root. scope is
// empty for the preferred root and names the original root for the short fallback.
func socketPathIn(root, base, scope string) (string, error) {
	if err := checkPrivateDir(root, false); err != nil {
		return "", err
	}
	key := strings.TrimRight(base, "/")
	if scope != "" {
		key = scope + "\x00" + key
	}
	sum := sha256.Sum256([]byte(key))
	dir := filepath.Join(root, socketDirPrefix+hex.EncodeToString(sum[:8]))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() || !info.IsDir() || info.Mode().Perm() != 0700 {
		return "", errors.New("unsafe communicator runtime directory")
	}
	return filepath.Join(dir, "control.sock"), nil
}

// Configure verifies signed config before enabling a remote. It has no network
// effects; the first managed request starts the communicator under its lock.
func Configure(ctx context.Context) {
	processContext = ctx
	key, err := signing.PublicKey()
	if err != nil {
		return
	}
	for _, engine := range []string{"codex", "claude", "grok"} {
		path, err := config.DefaultPathForEngine(engine)
		if err != nil {
			continue
		}
		cfg, err := config.LoadForEngine(path, key, false, engine)
		if err != nil || cfg.Orchestrator.CommunicatorProtocol != Protocol && cfg.Orchestrator.CommunicatorRuntimeProtocol != 1 {
			continue
		}
		socket, err := socketPath(cfg.Orchestrator.BaseURL)
		if err == nil {
			if owned, lookupErr := discoverResidentOwner(ctx, cfg.Orchestrator.BaseURL); lookupErr == nil && owned != "" {
				socket = owned
			}
		}
		base := strings.TrimRight(cfg.Orchestrator.BaseURL, "/")
		// A signed enabled capability remains registered even if local socket
		// setup fails. Otherwise Wrap would silently send the request directly.
		registry.LoadOrStore(base, &endpoint{base: base, path: path, socket: socket, setupErr: err, syncProtocol: cfg.Orchestrator.CommunicatorSyncProtocol, anchor: cfg, runtimeOnly: cfg.Orchestrator.CommunicatorProtocol != Protocol})
	}
}

func endpointFor(raw string) *endpoint {
	var found *endpoint
	registry.Range(func(k, v any) bool {
		base := k.(string)
		if raw == base || strings.HasPrefix(raw, base+"/") {
			found = v.(*endpoint)
			return false
		}
		return true
	})
	return found
}

// Wrap retains the original transport for URLs outside configured CoCo servers.
func Wrap(direct http.RoundTripper) http.RoundTripper {
	enabled := false
	registry.Range(func(_, _ any) bool { enabled = true; return false })
	if !enabled {
		return direct
	}
	return &Transport{Direct: direct}
}

type Transport struct{ Direct http.RoundTripper }

func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	ep := endpointFor(req.URL.String())
	if ep == nil || ep.transportDisabled() {
		return t.Direct.RoundTrip(req)
	}
	if err := ep.ensure(req.Context()); err != nil {
		if selfHealRequest(req, ep.base) {
			return t.Direct.RoundTrip(req)
		}
		return nil, err
	}
	ep.once.Do(func() { go ep.lease(processContext) })
	local := req.Clone(req.Context())
	original, _ := url.Parse(ep.base)
	local.URL.Scheme = "http"
	local.URL.Host = "communicator.local"
	local.URL.Path = strings.TrimPrefix(req.URL.Path, strings.TrimRight(original.Path, "/"))
	local.Host = "communicator.local"
	res, err := unixClient(ep.localSocket(), 0).Do(local)
	if err != nil && selfHealRequest(req, ep.base) {
		return t.Direct.RoundTrip(req)
	}
	if err != nil && req.Method != "GET" && req.Method != "HEAD" {
		return &http.Response{StatusCode: 409, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: responseBody([]byte(`{"error":{"code":"communicator_outcome_unknown","message":"Local communicator disconnected; request outcome unknown"}}`)), Request: req}, nil
	}
	return res, err
}

// selfHealRequest names the reads that repair a broken communicator: the
// signed config (verified by signature, and the only way to learn the
// capability was rolled back) and wrapper binary downloads (verified by the
// signed digest). They may use the original transport when no local owner can be
// started or reached; every other managed request stays fail-closed.
func selfHealRequest(req *http.Request, base string) bool {
	if req.Method != "GET" && req.Method != "HEAD" {
		return false
	}
	original, err := url.Parse(base)
	if err != nil {
		return false
	}
	path := strings.TrimPrefix(req.URL.Path, strings.TrimRight(original.Path, "/"))
	return path == "/wrapper/v2/config" || wrapperArtifactPath(path)
}

// wrapperArtifactPath names wrapper binary downloads, including the bakery's
// canonical /wrapper/v2/bin/<artifact>/<os>-<arch>/v<version>/<name> URL that
// signed configs carry. They are digest-verified and always large.
func wrapperArtifactPath(path string) bool {
	return strings.HasPrefix(path, "/wrapper/v2/bin/") ||
		strings.HasPrefix(path, "/wrapper/v2/download") || strings.HasPrefix(path, "/wrapper/download")
}

func unixClient(socket string, timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: &http.Transport{DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (ep *endpoint) transportDisabled() bool {
	ep.mu.Lock()
	defer ep.mu.Unlock()
	return ep.runtimeOnly
}

func (ep *endpoint) localSocket() string { ep.mu.Lock(); defer ep.mu.Unlock(); return ep.socket }

func (ep *endpoint) ensure(ctx context.Context) error {
	ep.mu.Lock()
	setupErr := ep.setupErr
	runtime := ep.anchor != nil && ep.anchor.Orchestrator.CommunicatorRuntimeProtocol == residency.Protocol
	ep.mu.Unlock()
	if setupErr != nil {
		return setupErr
	}
	if runtime {
		socket, err := resolvedRuntimeSocket(ctx, ep.base)
		if err != nil {
			return err
		}
		ep.mu.Lock()
		ep.socket = socket
		ep.mu.Unlock()
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", ep.localSocket())
	if err == nil {
		conn.Close()
		return nil
	}
	exe, err := executable()
	if err != nil {
		return err
	}
	ep.mu.Lock()
	path := ep.path
	anchor := ep.anchor
	paths := make([]string, 0, len(ep.jobs))
	for _, job := range ep.jobs {
		paths = append(paths, job.Config)
	}
	ep.mu.Unlock()
	if anchor != nil {
		key, err := signing.PublicKey()
		if err != nil {
			return err
		}
		sort.Strings(paths)
		cfg, err := selectSignedConfig(anchor, paths, key)
		if err != nil {
			return err
		}
		path = cfg.SourcePath()
	}
	cmd := exec.Command(exe, "communicator", "serve", "--config", path)
	cmd.Env = communicatorEnvironment(os.Environ())
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer null.Close()
	// A startup failure (an unbindable socket, a rejected config) is the one thing
	// the user needs to see, so the owner's stderr lands in a private log beside
	// the socket instead of /dev/null. A file descriptor, not a pipe: the owner
	// outlives this process and must never take SIGPIPE for logging.
	logPath := filepath.Join(filepath.Dir(ep.localSocket()), "serve.log")
	logFile, offset := openServeLog(logPath)
	if logFile != nil {
		defer logFile.Close()
		cmd.Stderr = logFile
	}
	cmd.Stdin, cmd.Stdout = null, null
	if err := cmd.Start(); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	failure := func(reason string) error {
		if detail := serveLogTail(logPath, offset); detail != "" {
			return fmt.Errorf("%s: %s", reason, detail)
		}
		return errors.New(reason)
	}
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(30 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-exited:
			// A clean exit means another owner already holds the lock and is still
			// binding; keep waiting for its socket. Anything else is final.
			if err != nil {
				return failure("communicator exited during startup (" + err.Error() + ")")
			}
			exited = nil
		case <-deadline.C:
			return failure("communicator failed to start; run cxx communicator doctor")
		case <-tick.C:
			conn, err := (&net.Dialer{}).DialContext(ctx, "unix", ep.localSocket())
			if err == nil {
				conn.Close()
				return nil
			}
		}
	}
}

const serveLogLimit = 64 * 1024

func openServeLog(path string) (*os.File, int64) {
	if info, err := os.Lstat(path); err == nil && info.Size() > serveLogLimit {
		_ = os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return nil, 0
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0
	}
	return f, info.Size()
}

// serveLogTail returns what the owner wrote since this attempt began,
// collapsed to one bounded line.
func serveLogTail(path string, offset int64) string {
	raw, err := os.ReadFile(path)
	if err != nil || int64(len(raw)) <= offset {
		return ""
	}
	// Bounded to the end of what was written, one line, printable text only: the child
	// is our own binary, but the text is shown on a terminal and must not be able to
	// move the cursor or recolour the screen.
	text := strings.TrimSpace(string(raw[offset:]))
	if len(text) > 4000 {
		text = text[len(text)-4000:]
	}
	text = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && !unicode.IsSpace(r) {
			return ' '
		}
		if r == unicode.ReplacementChar || !unicode.IsPrint(r) && !unicode.IsSpace(r) {
			return '?'
		}
		return r
	}, text)
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > 400 {
		text = text[len(text)-400:]
	}
	return text
}

func (ep *endpoint) lease(ctx context.Context) {
	for ctx.Err() == nil {
		if ep.ensure(ctx) == nil {
			ep.mu.Lock()
			leaseCtx, cancel := context.WithCancel(ctx)
			ep.leaseCancel = cancel
			runtimeAware := ep.anchor != nil && ep.anchor.Orchestrator.CommunicatorRuntimeProtocol == residency.Protocol
			jobs := make([]syncJob, 0, len(ep.jobs))
			for _, job := range ep.jobs {
				jobs = append(jobs, job)
			}
			ep.mu.Unlock()
			body, _ := json.Marshal(jobs)
			req, _ := http.NewRequestWithContext(leaseCtx, "POST", "http://communicator.local/_comm/lease", bytes.NewReader(body))
			if runtimeAware {
				req.Header.Set("X-CXX-Runtime-Protocol", "1")
			}
			res, err := unixClient(ep.localSocket(), 0).Do(req)
			if err == nil {
				io.Copy(io.Discard, res.Body)
				res.Body.Close()
			}
			cancel()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

// Unknown responses deliberately use 409: existing client retry loops must not
// turn a lost acknowledgement into another non-idempotent operation.
func writeUnavailable(w http.ResponseWriter, unknown bool) {
	writeUnavailableCause(w, unknown, "")
}

// writeUnavailableCause adds why the control connection is down to a 503, so a
// wrapper that prints the body shows the server's refusal (an IP binding, a
// revoked key, a disabled capability) instead of a code that only repeats itself.
func writeUnavailableCause(w http.ResponseWriter, unknown bool, cause string) {
	w.Header().Set("Content-Type", "application/json")
	code := "communicator_unavailable"
	message := code
	status := 503
	if unknown {
		code, message = "communicator_outcome_unknown", "communicator_outcome_unknown"
		status = 409
	} else if cause = oneLine(cause, 240); cause != "" {
		message = code + ": " + cause
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func (s *server) writeUnavailable(w http.ResponseWriter, unknown bool) {
	s.mu.Lock()
	cause := s.lastError
	s.mu.Unlock()
	writeUnavailableCause(w, unknown, cause)
}

// writeControlUnavailable answers a request that never reached the control channel.
// When the server refused this host's credentials at the handshake (invalid or
// revoked key, IP binding, reverse DNS, expired temporary host) the answer is that
// verdict with its real status and body, as direct HTTPS gave it: wrappers read
// 401/403 as a credential verdict and a 503 as an outage to retry or to bridge with
// cached auth, which would hide a revoked host. The request was never sent, so
// replaying nothing is lost; any other failure stays a retryable 503.
func (s *server) writeControlUnavailable(w http.ResponseWriter) {
	s.mu.Lock()
	refusal := s.refusal
	s.mu.Unlock()
	if refusal == nil {
		s.writeUnavailable(w, false)
		return
	}
	body := refusal.Body
	if !json.Valid(body) {
		body, _ = json.Marshal(map[string]any{"status": "error", "message": refusal.detail, "code": refusal.Code})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Cxx-Communicator-Refusal", "handshake")
	w.WriteHeader(refusal.Status)
	_, _ = w.Write(body)
}

// oneLine bounds a diagnostic to a single printable line.
func oneLine(text string, limit int) string {
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > limit {
		text = text[:limit]
	}
	return text
}

func bufferedBody(r *http.Request, limit int64) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	defer r.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, errors.New("communicator request too large")
	}
	return raw, nil
}
func responseBody(raw []byte) io.ReadCloser { return io.NopCloser(bytes.NewReader(raw)) }

func Direct(rt http.RoundTripper) (*http.Transport, bool) {
	if wrapped, ok := rt.(*Transport); ok {
		rt = wrapped.Direct
	}
	result, ok := rt.(*http.Transport)
	return result, ok
}

// A user-scoped transport must not inherit the launching agent's work claim,
// receiver identity, native writer or recovery ownership into background sync.
func communicatorEnvironment(env []string) []string {
	out := make([]string, 0, len(env))
	for _, entry := range env {
		blocked := false
		for _, prefix := range []string{"CXX_AGENT_", "CXX_DAEMON_", "CXX_REBOOT_", "CXX_WATCHDOG_", "CXX_NATIVE_", "CXX_PROVIDER_", "CXX_GROK_"} {
			if strings.HasPrefix(entry, prefix) {
				blocked = true
				break
			}
		}
		if !blocked {
			out = append(out, entry)
		}
	}
	return out
}

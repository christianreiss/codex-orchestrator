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
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
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
	base, path, socket string
	once               sync.Once
	leaseCancel        context.CancelFunc
	setupErr           error
}

func socketPath(base string) (string, error) {
	root := os.Getenv("XDG_RUNTIME_DIR")
	if root == "" {
		root = filepath.Join(os.TempDir(), fmt.Sprintf("cxx-%d", os.Getuid()))
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return "", err
	}
	rootStat, ok := rootInfo.Sys().(*syscall.Stat_t)
	if !ok || int(rootStat.Uid) != os.Getuid() || !rootInfo.IsDir() || rootInfo.Mode().Perm() != 0700 {
		return "", errors.New("unsafe communicator runtime root")
	}
	sum := sha256.Sum256([]byte(strings.TrimRight(base, "/")))
	dir := filepath.Join(root, "cxx-comm-"+hex.EncodeToString(sum[:8]))
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
		if err != nil || cfg.Orchestrator.CommunicatorProtocol != Protocol {
			continue
		}
		socket, err := socketPath(cfg.Orchestrator.BaseURL)
		base := strings.TrimRight(cfg.Orchestrator.BaseURL, "/")
		// A signed enabled capability remains registered even if local socket
		// setup fails. Otherwise Wrap would silently send the request directly.
		registry.LoadOrStore(base, &endpoint{base: base, path: path, socket: socket, setupErr: err, syncProtocol: cfg.Orchestrator.CommunicatorSyncProtocol})
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
	if ep == nil {
		return t.Direct.RoundTrip(req)
	}
	if err := ep.ensure(req.Context()); err != nil {
		return nil, err
	}
	ep.once.Do(func() { go ep.lease(processContext) })
	local := req.Clone(req.Context())
	original, _ := url.Parse(ep.base)
	local.URL.Scheme = "http"
	local.URL.Host = "communicator.local"
	local.URL.Path = strings.TrimPrefix(req.URL.Path, strings.TrimRight(original.Path, "/"))
	local.Host = "communicator.local"
	res, err := unixClient(ep.socket, 0).Do(local)
	if err != nil && req.Method != "GET" && req.Method != "HEAD" {
		return &http.Response{StatusCode: 409, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: responseBody([]byte(`{"error":{"code":"communicator_outcome_unknown","message":"Local communicator disconnected; request outcome unknown"}}`)), Request: req}, nil
	}
	return res, err
}

func unixClient(socket string, timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: &http.Transport{DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (ep *endpoint) ensure(ctx context.Context) error {
	ep.mu.Lock()
	setupErr := ep.setupErr
	ep.mu.Unlock()
	if setupErr != nil {
		return setupErr
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", ep.socket)
	if err == nil {
		conn.Close()
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	ep.mu.Lock()
	path := ep.path
	ep.mu.Unlock()
	cmd := exec.Command(exe, "communicator", "serve", "--config", path)
	cmd.Env = communicatorEnvironment(os.Environ())
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer null.Close()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = null, null, null
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(30 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("communicator failed to start; run cxx communicator doctor")
		case <-tick.C:
			conn, err := (&net.Dialer{}).DialContext(ctx, "unix", ep.socket)
			if err == nil {
				conn.Close()
				return nil
			}
		}
	}
}

func (ep *endpoint) lease(ctx context.Context) {
	for ctx.Err() == nil {
		if ep.ensure(ctx) == nil {
			ep.mu.Lock()
			leaseCtx, cancel := context.WithCancel(ctx)
			ep.leaseCancel = cancel
			jobs := make([]syncJob, 0, len(ep.jobs))
			for _, job := range ep.jobs {
				jobs = append(jobs, job)
			}
			ep.mu.Unlock()
			body, _ := json.Marshal(jobs)
			req, _ := http.NewRequestWithContext(leaseCtx, "POST", "http://communicator.local/_comm/lease", bytes.NewReader(body))
			res, err := unixClient(ep.socket, 0).Do(req)
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
	w.Header().Set("Content-Type", "application/json")
	code := "communicator_unavailable"
	status := 503
	if unknown {
		code = "communicator_outcome_unknown"
		status = 409
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": code}})
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

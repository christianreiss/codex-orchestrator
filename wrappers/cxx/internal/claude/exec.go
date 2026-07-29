package claude

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"golang.org/x/term"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// captureMaxBytes caps the in-memory stdout buffer for pipe-mode runs. The
// upstream Claude CLI prints "Token usage:" near the tail; ~1 MiB is plenty.
const captureMaxBytes = 1 << 20 // 1 MiB

func claudeBinCachePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".clx", "state", "claude-bin"), nil
}

// cacheClaude persists the resolved claude binary path for future runs.
func cacheClaude(path string) error {
	p, err := claudeBinCachePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, []byte(path), 0o644)
}

// cachedClaudeBin returns the previously cached claude binary path, or "" if
// the cache is missing, empty, or the path is no longer accessible.
func cachedClaudeBin() string {
	p, err := claudeBinCachePath()
	if err != nil {
		return ""
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	cached := strings.TrimSpace(string(b))
	if cached == "" {
		return ""
	}
	if _, err := os.Stat(cached); err != nil {
		return ""
	}
	return cached
}

// FindCLI locates the upstream `claude` binary (override via $CLX_CLAUDE_BIN).
// Checks the path cache before PATH lookup; writes the cache on a successful
// lookup so future runs (e.g. cron) work without a full npm-bin PATH.
// Falls back to `claude-code` if `claude` is missing.
func FindCLI() (string, error) {
	if v := strings.TrimSpace(os.Getenv("CLX_CLAUDE_BIN")); v != "" {
		if _, err := os.Stat(v); err == nil {
			return v, nil
		}
		return "", fmt.Errorf("CLX_CLAUDE_BIN points at %q which is not accessible", v)
	}
	if cached := cachedClaudeBin(); cached != "" && !isWrapperSelf(cached) {
		return cached, nil
	}
	// Self-shadow guard: skip any candidate that resolves to this running clx
	// wrapper. With `claude=clx` shell aliases in play, an operator may also
	// symlink/copy `claude` to clx on PATH; exec'ing that would re-enter clx
	// instead of the real Claude CLI, so interactive `claude auth login`
	// recovery could never reach the upstream login flow.
	for _, name := range []string{"claude", "claude-code"} {
		if path, err := exec.LookPath(name); err == nil {
			if isWrapperSelf(path) {
				continue
			}
			_ = cacheClaude(path)
			return path, nil
		}
	}
	return "", errors.New("claude CLI not found on PATH (install it or set CLX_CLAUDE_BIN)")
}

// isWrapperSelf reports whether path resolves (through symlinks) to this running
// wrapper executable. Used by FindCLI to break a would-be exec recursion.
func isWrapperSelf(path string) bool {
	self, err := os.Executable()
	if err != nil {
		return false
	}
	selfReal, err := filepath.EvalSymlinks(self)
	if err != nil {
		selfReal = self
	}
	pathReal, err := filepath.EvalSymlinks(path)
	if err != nil {
		pathReal = path
	}
	return selfReal == pathReal
}

// Run keeps the historical 2-return entry point for cmd/clx/main.go. New code
// should use RunCapture which also returns the buffered stdout used for
// token-usage extraction.
func Run(ctx context.Context, cfg *config.Config, args []string) (int, error) {
	exit, _, err := RunCapture(ctx, cfg, args)
	return exit, err
}

func RunWithAuthSession(ctx context.Context, cfg *config.Config, args []string, session *AuthSession) (int, error) {
	exit, _, err := RunCaptureWithAuthSession(ctx, cfg, args, session)
	return exit, err
}

// RunCapture execs `claude` with the wrapper env. Behaviour mirrors
// codex.RunCapture: tee stdout to a 1 MiB ring buffer when stdout is not a
// TTY, and set PROMPT_TOOLKIT_NO_CPR=1 when stdin or stdout is a pipe so the
// upstream CLI doesn't hang on a cursor-position probe.
func RunCapture(ctx context.Context, cfg *config.Config, args []string) (int, []byte, error) {
	return runCaptureWithHeldAuthLease(ctx, cfg, args, nil, nil)
}

func RunCaptureWithAuthSession(ctx context.Context, cfg *config.Config, args []string, session *AuthSession) (int, []byte, error) {
	return runCaptureWithHeldAuthLease(ctx, cfg, args, nil, session)
}

// RunExplicitLogout either runs the upstream logout under an exclusive
// active-child lease or, when a peer child is active, records durable intent and
// defers native removal without starting a destructive second child.
func RunExplicitLogout(ctx context.Context, cfg *config.Config, args []string, before AuthGeneration, session *AuthSession) (exit int, marked, deferred bool, retErr error) {
	guard, deferred, marked, err := beginExplicitLogout(before)
	if err != nil || guard == nil {
		return 0, marked, deferred, err
	}
	exit, _, runErr := runCaptureWithHeldAuthLease(ctx, cfg, args, guard.writer, session)
	marked, finishErr := guard.finish(runErr == nil && exit == 0)
	if runErr != nil {
		return exit, marked, false, errors.Join(runErr, finishErr)
	}
	return exit, marked, false, finishErr
}

func runCaptureWithHeldAuthLease(ctx context.Context, cfg *config.Config, args []string, heldLease *authChildLease, session *AuthSession) (int, []byte, error) {
	return runCaptureWithHeldAuthLeaseUsing(ctx, cfg, args, heldLease, session, acquireAuthChildShared)
}

func runCaptureWithHeldAuthLeaseUsing(
	ctx context.Context,
	cfg *config.Config,
	args []string,
	heldLease *authChildLease,
	session *AuthSession,
	acquireShared func() (*authChildLease, error),
) (int, []byte, error) {
	cli, err := FindCLI()
	if err != nil {
		return 127, nil, err
	}
	// PreExec returns an error only on an FQDN guard mismatch (a documented
	// launch refusal); honour it instead of launching Claude against the wrong
	// host identity. Mirrors cdx/internal/codex/exec.go.
	teardown, err := PreExec(ctx, cfg)
	if err != nil {
		return 1, nil, err
	}
	defer teardown()

	// Hold the active-child lease before reading or copying any credential.
	// Otherwise an explicit logout can win between managedRuntimeAuth and the
	// eventual shared-lock acquisition, while this child still launches with a
	// stale API key already copied into its environment/settings overlay.
	childLease := heldLease
	closeChildLease := false
	if childLease == nil {
		childLease, err = acquireShared()
		if err != nil {
			return 1, nil, fmt.Errorf("acquire Claude auth child lease: %w", err)
		}
		closeChildLease = true
	}

	stdoutIsTTY := term.IsTerminal(int(os.Stdout.Fd()))
	stdinIsTTY := term.IsTerminal(int(os.Stdin.Fd()))

	args, replacedBare := normalizeRuntimeAuthArgs(args)
	if replacedBare {
		fmt.Fprintln(os.Stderr, "clx: --bare ignores subscription OAuth; using --safe-mode so verified Claude login remains active.")
	}
	env := buildEnv(cfg, args)
	if !stdoutIsTTY || !stdinIsTTY {
		env = append(env, "PROMPT_TOOLKIT_NO_CPR=1")
	}

	args, cleanupRuntimeAuth, err := prepareRuntimeAuthSettings(args)
	if err != nil {
		if closeChildLease {
			_ = childLease.Close()
		}
		return 1, nil, err
	}
	defer cleanupRuntimeAuth()
	cmd := exec.CommandContext(ctx, cli, args...)
	cmd.Env = env
	cmd.Stdin = os.Stdin
	cmd.Stderr = os.Stderr

	var capture *ringBuffer
	if stdoutIsTTY {
		cmd.Stdout = os.Stdout
	} else {
		capture = newRingBuffer(captureMaxBytes)
		cmd.Stdout = io.MultiWriter(os.Stdout, capture)
	}

	closeExtras, err := attachAuthLeaseFiles(cmd, session, childLease)
	if err != nil {
		if closeChildLease {
			_ = childLease.Close()
		}
		return 1, nil, fmt.Errorf("inherit Claude auth leases: %w", err)
	}
	if err := cmd.Start(); err != nil {
		closeExtras()
		if closeChildLease {
			_ = childLease.Close()
		}
		return 127, nil, fmt.Errorf("start claude: %w", err)
	}
	closeExtras()

	sigCh := make(chan os.Signal, 4)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		for s := range sigCh {
			if cmd.Process != nil {
				_ = cmd.Process.Signal(s)
			}
		}
	}()

	waitErr := cmd.Wait()
	var leaseErr error
	if closeChildLease {
		leaseErr = childLease.Close()
	}
	signal.Stop(sigCh)
	close(sigCh)

	var captured []byte
	if capture != nil {
		captured = capture.Bytes()
	}

	if waitErr == nil && leaseErr != nil {
		return 1, captured, fmt.Errorf("release Claude auth child lease: %w", leaseErr)
	}
	if waitErr == nil {
		return 0, captured, nil
	}
	if exitErr, ok := waitErr.(*exec.ExitError); ok {
		return exitErr.ExitCode(), captured, nil
	}
	return 1, captured, waitErr
}

// ringBuffer is the same thread-safe append-with-trim buffer used by cdx.
type ringBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
	cap int
}

func newRingBuffer(cap int) *ringBuffer {
	return &ringBuffer{cap: cap}
}

func (r *ringBuffer) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n, err := r.buf.Write(p)
	if r.buf.Len() > r.cap {
		excess := r.buf.Len() - r.cap
		_ = r.buf.Next(excess)
	}
	return n, err
}

func (r *ringBuffer) Bytes() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]byte, r.buf.Len())
	copy(out, r.buf.Bytes())
	return out
}

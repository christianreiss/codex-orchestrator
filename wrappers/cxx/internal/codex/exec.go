package codex

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
	"time"

	"golang.org/x/term"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/quotaadvice"
)

// captureMaxBytes caps the in-memory stdout buffer for pipe-mode runs. The
// upstream Codex CLI's "Token usage:" footer line lives at the very tail of
// output, so we keep the most recent ~1 MB and discard older bytes.
const captureMaxBytes = 1 << 20 // 1 MiB

func codexBinCachePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "codex-orchestrator", "cdx-codex-bin"), nil
}

// cacheCodex persists the resolved codex binary path for future runs.
func cacheCodex(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return cacheCodexContext(ctx, path)
}

func cacheCodexContext(ctx context.Context, path string) error {
	p, err := codexBinCachePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		lock, err := ipc.TryAcquireExclusivePath(p + ".lock")
		if err == nil {
			defer lock.Release()
			return atomicWriteFile(p, []byte(path), 0o644)
		}
		if !errors.Is(err, ipc.ErrHeld) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

// Cache discovery never waits for a publisher. A release published after this
// launch's initial cache miss wins over its older PATH discovery.
func cacheDiscoveredCodex(path string) string {
	p, err := codexBinCachePath()
	if err != nil {
		return path
	}
	lock, err := ipc.TryAcquireExclusivePath(p + ".lock")
	if err != nil {
		return path
	}
	defer lock.Release()
	if current := cachedCodexBin(); current != "" && !isWrapperSelf(current) {
		return current
	}
	_ = atomicWriteFile(p, []byte(path), 0o644)
	return path
}

// cachedCodexBin returns the previously cached codex binary path, or "" if
// the cache is missing, empty, or the path is no longer accessible.
func cachedCodexBin() string {
	p, err := codexBinCachePath()
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

// FindCLI locates the upstream `codex` binary on PATH (override via $CDX_CODEX_BIN).
// Checks the path cache before PATH lookup; writes the cache on a successful
// lookup so future runs (e.g. cron) work without a full npm-bin PATH.
//
// A self-shadow guard skips any candidate that resolves to this running wrapper:
// if an operator points `codex` at cdx (symlink/copy on PATH, the natural
// companion to a `codex=cdx` shell alias), exec'ing it would re-enter cdx
// instead of the real Codex CLI — so `cdx login` / interactive recovery could
// never reach the upstream login flow. Better to fail loudly with a fix-it hint.
func FindCLI() (string, error) {
	if v := strings.TrimSpace(os.Getenv("CDX_CODEX_BIN")); v != "" {
		if _, err := os.Stat(v); err == nil {
			return v, nil
		}
		return "", fmt.Errorf("CDX_CODEX_BIN points at %q which is not accessible", v)
	}
	if cached := cachedCodexBin(); cached != "" && !isWrapperSelf(cached) {
		return cached, nil
	}
	path, err := exec.LookPath("codex")
	if err != nil {
		return "", errors.New("codex CLI not found on PATH; run `cdx cron run` to install the managed version, or install Codex and set CDX_CODEX_BIN")
	}
	if isWrapperSelf(path) {
		return "", errors.New("resolved \"codex\" to the cdx wrapper itself; set CDX_CODEX_BIN to the real Codex CLI")
	}
	return cacheDiscoveredCodex(path), nil
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

// Run is the historical 2-return entry point retained for backwards
// compatibility with `cmd/cdx/main.go`. New code should call RunCapture, which
// also returns the buffered stdout used for token-usage extraction.
//
// Side effects: see RunCapture.
func Run(ctx context.Context, cfg *config.Config, args []string) (int, error) {
	exit, _, err := RunCapture(ctx, cfg, args)
	return exit, err
}

// RunCapture execs `codex` with the wrapper's prepared env. Signals are
// forwarded and the child's exit status is propagated.
//
// When stdout is NOT a TTY (pipe-mode), the child's stdout is tee'd into a
// ring-buffer capped at captureMaxBytes; that buffer is returned so the
// lifecycle can scan it for the upstream "Token usage:" footer.
//
// When stdout IS a TTY, captured is returned as nil — the wrapper relies on
// JSONL session-file discovery for interactive runs.
//
// Side effects:
//   - Adds the current cwd to ~/.codex/config.toml under [projects.…] trust_level=trusted.
//   - Exports OTEL_* env vars derived from the [otel] block in config.toml.
//   - Starts an IPv4-forcing local proxy when CODEX_FORCE_IPV4=1.
//   - Selects a model/profile based on lane preference when neither is given.
//   - Sets PROMPT_TOOLKIT_NO_CPR=1 when stdin or stdout is not a TTY so the
//     upstream prompt_toolkit-based CLI doesn't probe cursor position over a
//     pipe (the probe never returns and hangs the child).
func RunCapture(ctx context.Context, cfg *config.Config, args []string) (int, []byte, error) {
	teardown, err := PreExec(ctx, cfg)
	if err != nil {
		return 1, nil, err
	}
	defer teardown()

	return RunCapturePrepared(ctx, cfg, args)
}

// RunCapturePrepared runs the upstream Codex CLI after the caller has already
// completed PreExec and arranged to call its teardown. Lifecycle uses this so
// the boot screen's "Ready" line is printed only after wrapper-side setup.
func RunCapturePrepared(ctx context.Context, cfg *config.Config, args []string) (exitCode int, captured []byte, runErr error) {
	authSessionLease, err := StartAuthSession(cfg != nil && !cfg.Host.Secure)
	if err != nil {
		return 1, nil, fmt.Errorf("acquire auth session lease: %w", err)
	}
	defer func() {
		_, _, cleanupErr := FinishAuthSession(authSessionLease)
		if cleanupErr != nil {
			runErr = errors.Join(runErr, fmt.Errorf("finish auth session: %w", cleanupErr))
			if exitCode == 0 {
				exitCode = 1
			}
		}
	}()

	childLease, err := AcquireActiveChild()
	if err != nil {
		return 1, nil, fmt.Errorf("acquire active Codex child lease: %w", err)
	}
	defer func() {
		if cleanupErr := childLease.Release(); cleanupErr != nil {
			runErr = errors.Join(runErr, fmt.Errorf("release active Codex child lease: %w", cleanupErr))
			if exitCode == 0 {
				exitCode = 1
			}
		}
	}()

	return runCapturePreparedWithHeldLeases(ctx, cfg, args, authSessionLease, childLease)
}

// runCapturePreparedWithHeldLeases supervises one native Codex child using
// caller-owned coordination leases. Standard runs pass a shared AuthSession +
// active-child lease; explicit logout passes exclusive maintenance + writer
// leases so no shared process can queue through its destructive transaction.
func runCapturePreparedWithHeldLeases(ctx context.Context, cfg *config.Config, args []string, session *AuthSession, childLease *ipc.Lock, extraLeases ...*ipc.Lock) (exitCode int, captured []byte, runErr error) {
	cli, err := FindCLI()
	if err != nil {
		return 127, nil, err
	}

	args = applyLaneAndProfile(cfg, args)
	args = applyDangerousBypass(cfg, args)
	args = disableStartupUpdateCheck(args)

	stdoutIsTTY := term.IsTerminal(int(os.Stdout.Fd()))
	stdinIsTTY := term.IsTerminal(int(os.Stdin.Fd()))

	env := BuildEnv(cfg)
	if !stdoutIsTTY || !stdinIsTTY {
		env = append(env, "PROMPT_TOOLKIT_NO_CPR=1")
	}

	if cfg != nil && cfg.AgentMessaging.ReceiverEnabled && stdoutIsTTY && stdinIsTTY && os.Getenv("CXX_AGENT_PORTAL_SOCKET") != "" {
		receiverArgs, stopReceiver, receiverErr := startReceiverServer(ctx, cli, args, env, session, childLease)
		if receiverErr != nil {
			fmt.Fprintln(os.Stderr, "cxx receiver unavailable:", receiverErr)
		} else {
			args = receiverArgs
			defer stopReceiver()
		}
	}

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

	closeExtras, err := AttachAuthLeaseFiles(cmd, session, append([]*ipc.Lock{childLease}, extraLeases...)...)
	if err != nil {
		return 1, nil, fmt.Errorf("inherit Codex auth safety leases: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return 127, nil, errors.Join(fmt.Errorf("start codex: %w", err), closeExtras())
	}
	quotaadvice.MarkStarted(ctx)
	bridgeErr := closeExtras()

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
	signal.Stop(sigCh)
	close(sigCh)

	if capture != nil {
		captured = capture.Bytes()
	}

	if bridgeErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			return exitErr.ExitCode(), captured, fmt.Errorf("release inherited Codex auth lease copies: %w", bridgeErr)
		}
		return 1, captured, errors.Join(waitErr, fmt.Errorf("release inherited Codex auth lease copies: %w", bridgeErr))
	}
	if waitErr == nil {
		return 0, captured, nil
	}
	if exitErr, ok := waitErr.(*exec.ExitError); ok {
		return exitErr.ExitCode(), captured, nil
	}
	return 1, captured, waitErr
}

// Codex rust-v0.153.4 documents this option for centrally managed updates;
// tui/src/updates.rs gates both version requests and update prompts on it.
// Global -c overrides are applied in order, so put ours last before the prompt
// sentinel without changing any prompt bytes or the caller's argument slice.
func disableStartupUpdateCheck(args []string) []string {
	boundary := len(args)
	for i, arg := range args {
		if arg == "--" {
			boundary = i
			break
		}
	}
	out := make([]string, 0, len(args)+2)
	out = append(out, args[:boundary]...)
	out = append(out, "-c", "check_for_update_on_startup=false")
	return append(out, args[boundary:]...)
}

// ringBuffer is a thread-safe append-only buffer that drops oldest bytes once
// it exceeds cap. We don't need a true ring; the simpler "trim from the front
// when over cap" strategy is fine because writes are mostly sequential and the
// regex scans the tail.
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
		// Trim from the front, keeping the last cap bytes.
		excess := r.buf.Len() - r.cap
		_ = r.buf.Next(excess)
	}
	return n, err
}

func (r *ringBuffer) Bytes() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	// Copy so callers can read after we release the lock.
	out := make([]byte, r.buf.Len())
	copy(out, r.buf.Bytes())
	return out
}

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

	"golang.org/x/term"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
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
	p, err := codexBinCachePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, []byte(path), 0o644)
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
func FindCLI() (string, error) {
	if v := strings.TrimSpace(os.Getenv("CDX_CODEX_BIN")); v != "" {
		if _, err := os.Stat(v); err == nil {
			return v, nil
		}
		return "", fmt.Errorf("CDX_CODEX_BIN points at %q which is not accessible", v)
	}
	if cached := cachedCodexBin(); cached != "" {
		return cached, nil
	}
	path, err := exec.LookPath("codex")
	if err != nil {
		return "", errors.New("codex CLI not found on PATH (install it or set CDX_CODEX_BIN)")
	}
	_ = cacheCodex(path)
	return path, nil
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
	cli, err := FindCLI()
	if err != nil {
		return 127, nil, err
	}

	teardown, _ := PreExec(ctx, cfg)
	defer teardown()

	args = applyLaneAndProfile(cfg, args)
	args = applyDangerousBypass(cfg, args)

	stdoutIsTTY := term.IsTerminal(int(os.Stdout.Fd()))
	stdinIsTTY := term.IsTerminal(int(os.Stdin.Fd()))

	env := BuildEnv(cfg)
	if !stdoutIsTTY || !stdinIsTTY {
		env = append(env, "PROMPT_TOOLKIT_NO_CPR=1")
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

	if err := cmd.Start(); err != nil {
		return 127, nil, fmt.Errorf("start codex: %w", err)
	}

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

	var captured []byte
	if capture != nil {
		captured = capture.Bytes()
	}

	if waitErr == nil {
		return 0, captured, nil
	}
	if exitErr, ok := waitErr.(*exec.ExitError); ok {
		return exitErr.ExitCode(), captured, nil
	}
	return 1, captured, waitErr
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

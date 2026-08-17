package agentbus

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

const (
	// Detached Claude daemons can outlive the clx process that spawned them and
	// rotate the shared OAuth pair long after the foreground watcher has exited.
	// Keep this poll local and cheap; network traffic happens only when the
	// credential generation changes.
	persistentClaudeAuthWatchInterval = 2 * time.Second
	persistentClaudeAuthUploadTimeout = 20 * time.Second
	persistentClaudeAuthRetryBackoff  = 5 * time.Second
	persistentClaudeAuthRetryMax      = 5 * time.Minute
)

type persistentClaudeAuthWatchDeps struct {
	snapshot func() (claude.AuthSnapshot, error)
	upload   func(context.Context) error
	interval time.Duration
	backoff  time.Duration
	maxDelay time.Duration
	timeout  time.Duration
	logger   *slog.Logger
}

var runClaudeAuthUpload = func(ctx context.Context) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, executable, "claude", "auth-upload")
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("clx auth-upload: %w", err)
	}
	return nil
}

// runPersistentClaudeAuthWatch closes the lifecycle hole left by native
// `claude daemon run` processes. The foreground clx watcher remains the fast
// path for ordinary sessions; this per-user worker covers credential writers
// that survive their parent wrapper or were launched outside it.
func runPersistentClaudeAuthWatch(ctx context.Context, logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	runPersistentClaudeAuthWatchWithDeps(ctx, persistentClaudeAuthWatchDeps{
		snapshot: persistentClaudeAuthSnapshot,
		upload:   runClaudeAuthUpload,
		interval: persistentClaudeAuthWatchInterval,
		backoff:  persistentClaudeAuthRetryBackoff,
		maxDelay: persistentClaudeAuthRetryMax,
		timeout:  persistentClaudeAuthUploadTimeout,
		logger:   logger,
	})
}

func persistentClaudeAuthSnapshot() (claude.AuthSnapshot, error) {
	configPath, err := config.DefaultPathForEngine(config.EngineClaude)
	if err != nil {
		return claude.AuthSnapshot{}, err
	}
	if _, err := os.Stat(configPath); err != nil {
		if os.IsNotExist(err) {
			return claude.AuthSnapshot{}, nil
		}
		return claude.AuthSnapshot{}, err
	}
	return claude.ReadAuthSnapshot(false)
}

func runPersistentClaudeAuthWatchWithDeps(ctx context.Context, deps persistentClaudeAuthWatchDeps) {
	if deps.interval <= 0 {
		deps.interval = persistentClaudeAuthWatchInterval
	}
	if deps.backoff <= 0 {
		deps.backoff = persistentClaudeAuthRetryBackoff
	}
	if deps.maxDelay <= 0 {
		deps.maxDelay = persistentClaudeAuthRetryMax
	}
	if deps.maxDelay < deps.backoff {
		deps.maxDelay = deps.backoff
	}
	if deps.timeout <= 0 {
		deps.timeout = persistentClaudeAuthUploadTimeout
	}
	if deps.logger == nil {
		deps.logger = slog.Default()
	}

	var lastHandled claude.AuthGeneration
	var failedGeneration claude.AuthGeneration
	var failedAt time.Time
	failedAttempts := 0
	initialized := false
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		timer.Reset(deps.interval)

		snap, err := deps.snapshot()
		if err != nil || !snap.Usable || !snap.Generation.Exists {
			continue
		}
		if !initialized {
			initialized = true
			// A valid server binding proves this exact native digest was already
			// materialized from canonical storage. Avoid a fleet-wide no-op store
			// burst whenever a new wrapper restarts every worker. A native refresh
			// changes the digest, so the binding disappears and is uploaded below.
			if snap.ServerDigest != "" {
				lastHandled = snap.Generation
				continue
			}
		}
		if snap.Generation == lastHandled {
			continue
		}
		if snap.Generation == failedGeneration && time.Since(failedAt) < exponentialBackoff(deps.backoff, deps.maxDelay, failedAttempts) {
			continue
		}

		uploadCtx, cancel := context.WithTimeout(ctx, deps.timeout)
		uploadErr := deps.upload(uploadCtx)
		cancel()
		if uploadErr != nil {
			if ctx.Err() != nil {
				return
			}
			if snap.Generation == failedGeneration {
				failedAttempts++
			} else {
				failedAttempts = 1
			}
			failedGeneration = snap.Generation
			failedAt = time.Now()
			deps.logger.Warn("persistent Claude auth upload failed; will retry", "err", uploadErr)
			continue
		}

		// Mark only the generation selected before the subprocess. A native
		// daemon can rotate again while auth-upload is in flight; treating an
		// arbitrary post-request generation as handled would silently lose that
		// newer rotation. A server-canonical writeback may therefore produce one
		// harmless follow-up no-op upload, while a genuinely newer local branch is
		// guaranteed to be offered.
		lastHandled = snap.Generation
		failedGeneration = claude.AuthGeneration{}
		failedAt = time.Time{}
		failedAttempts = 0
		deps.logger.Debug("persistent Claude auth generation uploaded")
	}
}

func exponentialBackoff(base, maximum time.Duration, attempts int) time.Duration {
	if attempts <= 1 || base >= maximum {
		return base
	}
	delay := base
	for attempt := 1; attempt < attempts; attempt++ {
		if delay >= maximum/2 {
			return maximum
		}
		delay *= 2
	}
	if delay > maximum {
		return maximum
	}
	return delay
}

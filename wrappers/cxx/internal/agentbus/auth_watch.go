package agentbus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

const (
	// Detached Claude daemons can outlive the clx process that spawned them and
	// rotate the shared OAuth pair long after the foreground watcher has exited.
	// Keep this poll local and cheap; network traffic happens when credentials
	// change or a managed child needs its periodic canonical refresh.
	persistentAuthWatchInterval = 2 * time.Second
	persistentAuthUploadTimeout = 20 * time.Second
	persistentAuthRetryBackoff  = 5 * time.Second
	persistentAuthRetryMax      = time.Minute
	persistentAuthSyncInterval  = 30 * time.Second
)

type persistentAuthGeneration struct {
	Exists bool
	Digest string
}
type persistentAuthSnapshot struct {
	Generation   persistentAuthGeneration
	Usable       bool
	ServerDigest string
}

type persistentAuthWatchDeps struct {
	engine       string
	sync         func(context.Context) error
	active       func() (bool, error)
	syncInterval time.Duration
	snapshot     func() (persistentAuthSnapshot, error)
	upload       func(context.Context) error
	interval     time.Duration
	backoff      time.Duration
	maxDelay     time.Duration
	timeout      time.Duration
	logger       *slog.Logger
}

var runPersistentAuthCommand = func(ctx context.Context, engine, command string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, executable, engine, command)
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w", engine, command, err)
	}
	return nil
}

// Keep each engine independent: an upload failure or a blocked native writer
// in one credential store cannot delay a rotation in the other.
func runPersistentAuthWatch(ctx context.Context, engine string, logger *slog.Logger) {
	active := codex.HasActiveAuthChild
	if engine == config.EngineClaude {
		active = claude.HasActiveAuthChild
	}
	runPersistentAuthWatchWithDeps(ctx, persistentAuthWatchDeps{
		engine:   engine,
		snapshot: func() (persistentAuthSnapshot, error) { return persistentAuthSnapshotForEngine(ctx, engine) },
		upload:   func(ctx context.Context) error { return runPersistentAuthCommand(ctx, engine, "auth-upload-auto") },
		sync:     func(ctx context.Context) error { return runPersistentAuthCommand(ctx, engine, "auth-sync") },
		active:   active,
		logger:   logger,
	})
}

func persistentAuthSnapshotForEngine(ctx context.Context, engine string) (persistentAuthSnapshot, error) {
	path, err := config.DefaultPathForEngine(engine)
	if err != nil {
		return persistentAuthSnapshot{}, err
	}
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return persistentAuthSnapshot{}, nil
		}
		return persistentAuthSnapshot{}, err
	}
	if engine == config.EngineClaude {
		intent, err := claude.CurrentLogoutIntentGenerationContext(ctx)
		if err != nil || intent.Exists {
			return persistentAuthSnapshot{}, err
		}
		snap, err := claude.ReadAuthSnapshotContext(ctx, false)
		return persistentAuthSnapshot{Generation: persistentAuthGeneration{Exists: snap.Generation.Exists, Digest: snap.Generation.Digest}, Usable: snap.Usable, ServerDigest: snap.ServerDigest}, err
	}
	if engine != config.EngineCodex {
		return persistentAuthSnapshot{}, fmt.Errorf("unknown auth engine")
	}
	intent, err := codex.CurrentLogoutIntentGenerationContext(ctx)
	if err != nil || intent.Exists {
		return persistentAuthSnapshot{}, err
	}
	path, err = codex.AuthPath()
	if err != nil {
		return persistentAuthSnapshot{}, err
	}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return persistentAuthSnapshot{}, nil
	}
	if err != nil {
		return persistentAuthSnapshot{}, err
	}
	var auth struct {
		Key    string `json:"OPENAI_API_KEY"`
		Tokens struct {
			Access string `json:"access_token"`
		} `json:"tokens"`
		Auths map[string]json.RawMessage `json:"auths"`
	}
	if err := json.Unmarshal(raw, &auth); err != nil {
		return persistentAuthSnapshot{}, err
	}
	sum := sha256.Sum256(raw)
	generation := codex.AuthGeneration{Exists: true, Digest: hex.EncodeToString(sum[:])}
	bound, err := codex.IsCanonicalAuthGeneration(generation)
	if err != nil {
		return persistentAuthSnapshot{}, err
	}
	snap := persistentAuthSnapshot{Generation: persistentAuthGeneration{Exists: true, Digest: generation.Digest}, Usable: strings.TrimSpace(auth.Key) != "" || strings.TrimSpace(auth.Tokens.Access) != "" || len(auth.Auths) > 0}
	if bound {
		snap.ServerDigest = generation.Digest
	}
	return snap, nil
}

func runPersistentAuthWatchWithDeps(ctx context.Context, deps persistentAuthWatchDeps) {
	if deps.interval <= 0 {
		deps.interval = persistentAuthWatchInterval
	}
	if deps.backoff <= 0 {
		deps.backoff = persistentAuthRetryBackoff
	}
	if deps.maxDelay <= 0 {
		deps.maxDelay = persistentAuthRetryMax
	}
	if deps.maxDelay < deps.backoff {
		deps.maxDelay = deps.backoff
	}
	if deps.timeout <= 0 {
		deps.timeout = persistentAuthUploadTimeout
	}
	if deps.syncInterval <= 0 {
		deps.syncInterval = persistentAuthSyncInterval
	}
	if deps.logger == nil {
		deps.logger = slog.Default()
	}

	var lastHandled persistentAuthGeneration
	var failedGeneration persistentAuthGeneration
	var failedAt time.Time
	failedAttempts := 0
	var nextSync time.Time
	syncFailures := 0
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
		if snap.ServerDigest != "" {
			lastHandled = snap.Generation
		}
		if snap.Generation == lastHandled {
			if deps.sync == nil || deps.active == nil || time.Now().Before(nextSync) {
				continue
			}
			active, err := deps.active()
			if err != nil || !active {
				continue
			}
			syncCtx, cancel := context.WithTimeout(ctx, deps.timeout)
			err = deps.sync(syncCtx)
			cancel()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				syncFailures++
				nextSync = time.Now().Add(exponentialBackoff(deps.backoff, deps.maxDelay, syncFailures))
				deps.logger.Warn("active-session auth sync failed; will retry", "engine", deps.engine)
			} else {
				syncFailures = 0
				nextSync = time.Now().Add(deps.syncInterval)
			}
			continue
		}

		if snap.Generation == failedGeneration && time.Since(failedAt) < exponentialBackoff(deps.backoff, deps.maxDelay, failedAttempts) {
			continue
		}

		uploadCtx, cancel := context.WithTimeout(ctx, deps.timeout)
		var uploadErr error
		active := false
		if deps.active != nil && deps.sync != nil {
			active, uploadErr = deps.active()
		}
		if uploadErr == nil {
			if active {
				// Active convergence offers local bytes first and adopts a verified
				// canonical winner. Idle uploads deliberately avoid materializing
				// credentials, so they cannot heal this running session.
				uploadErr = deps.sync(uploadCtx)
			} else {
				uploadErr = deps.upload(uploadCtx)
			}
		}
		cancel()
		if uploadErr == nil && active {
			// auth-sync can exit successfully after the child became idle or
			// acceptance was deferred. Only an exact local/server binding proves
			// that this unbound candidate has actually converged.
			current, snapshotErr := deps.snapshot()
			if snapshotErr != nil {
				uploadErr = snapshotErr
			} else if current.Generation != snap.Generation {
				// Leave a concurrent native rotation for the next tick. A bound
				// canonical replacement is also discovered there, but need not
				// immediately repeat the active-session poll we just completed.
				if current.ServerDigest != "" {
					syncFailures = 0
					nextSync = time.Now().Add(deps.syncInterval)
				}
				continue
			} else if current.ServerDigest == "" {
				uploadErr = fmt.Errorf("active auth sync left candidate unbound")
			}
		}
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
			deps.logger.Warn("persistent auth upload failed; will retry", "engine", deps.engine)
			continue
		}

		// Mark only the generation selected before the subprocess. A native
		// daemon can rotate again while auth-upload is in flight; treating an
		// arbitrary post-request generation as handled would silently lose that
		// newer rotation. A server-canonical writeback may therefore produce one
		// harmless follow-up no-op upload, while a genuinely newer local branch is
		// guaranteed to be offered.
		lastHandled = snap.Generation
		failedGeneration = persistentAuthGeneration{}
		failedAt = time.Time{}
		failedAttempts = 0
		if active {
			syncFailures = 0
			nextSync = time.Now().Add(deps.syncInterval)
		}
		deps.logger.Debug("persistent auth generation uploaded", "engine", deps.engine)
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

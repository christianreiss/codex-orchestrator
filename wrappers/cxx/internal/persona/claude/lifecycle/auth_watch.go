// Mid-session auth convergence watcher. Claude Code rotates its OAuth pair
// natively whenever the access token expires during a session, and Anthropic
// rotates the refresh token on every refresh: until the child generation
// reaches the orchestrator, the canonical copy is a superseded sibling of the
// same grant, and every other holder of it is one replayed refresh away from
// getting the family revoked. The post-run upload alone leaves that gap open
// for the whole session, so this watcher polls the native credentials file
// while the child runs and uploads each new usable generation within one
// interval of its mint.
package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

const (
	authWatchInterval      = 2 * time.Second
	authWatchPullInterval  = 30 * time.Second
	authWatchUploadTimeout = 15 * time.Second
	// A generation whose upload failed is retried, but not on every tick: the
	// next poll would hit the same server state, and the post-run upload is
	// still behind it as a backstop.
	authWatchRetryBackoff = 5 * time.Second
	authWatchRetryMax     = time.Minute
)

type authWatchDeps struct {
	// snapshot reads the current native generation without taking the upload
	// transaction lease.
	snapshot        func() (claude.AuthSnapshot, error)
	snapshotContext func(context.Context) (claude.AuthSnapshot, error)
	// upload runs the single automatic AuthStore transaction and returns the
	// exact snapshot it submitted.
	upload       func(context.Context) (claude.AuthSnapshot, error)
	pull         func(context.Context) (claude.AuthSnapshot, error)
	interval     time.Duration
	pullInterval time.Duration
	backoff      time.Duration
	maxBackoff   time.Duration
	timeout      time.Duration
	logger       *slog.Logger
}

// startMidSessionAuthUpload launches the watcher goroutine and returns an
// idempotent stop function that cancels it and waits for it to exit, so no
// watcher upload can overlap the post-run upload.
func startMidSessionAuthUpload(
	ctx context.Context,
	client *orchestrator.Client,
	logger *slog.Logger,
	before claude.AuthGeneration,
	session *claude.AuthSession,
) (stop func()) {
	syncAuth := func(sctx context.Context) (claude.AuthSnapshot, error) {
		result, err := SyncSessionAuth(sctx, client, logger)
		if result.HostSecure != nil && session != nil {
			err = errors.Join(err, session.SetPurgeOnLastExitContext(sctx, !*result.HostSecure))
		}
		return claude.AuthSnapshot{Generation: result.Generation}, err
	}
	deps := authWatchDeps{
		snapshotContext: func(sctx context.Context) (claude.AuthSnapshot, error) {
			return claude.ReadAuthSnapshotContext(sctx, false)
		},
		upload:       syncAuth,
		pull:         syncAuth,
		interval:     authWatchInterval,
		pullInterval: authWatchPullInterval,
		backoff:      authWatchRetryBackoff,
		maxBackoff:   authWatchRetryMax,
		timeout:      authWatchUploadTimeout,
		logger:       logger,
	}
	watchCtx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		runAuthUploadWatcher(watchCtx, deps, before)
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			wg.Wait()
		})
	}
}

func runAuthUploadWatcher(ctx context.Context, deps authWatchDeps, before claude.AuthGeneration) {
	if deps.pullInterval <= 0 {
		deps.pullInterval = authWatchPullInterval
	}
	if deps.maxBackoff < deps.backoff {
		deps.maxBackoff = deps.backoff
	}
	lastHandled := before
	var failedGeneration claude.AuthGeneration
	var retryAt, lastPull time.Time
	failedAttempts := 0
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		timer.Reset(deps.interval)
		var snap claude.AuthSnapshot
		var err error
		if deps.snapshotContext != nil {
			snap, err = deps.snapshotContext(ctx)
		} else {
			snap, err = deps.snapshot()
		}
		if err != nil || !snap.Usable {
			// Absent, unreadable, or logged-out credentials are the post-run
			// handler's business (logout tracking), never the watcher's.
			continue
		}
		if snap.Generation == failedGeneration && time.Now().Before(retryAt) {
			continue
		}
		operation := deps.upload
		if snap.Generation == lastHandled {
			if deps.pull == nil || time.Since(lastPull) < deps.pullInterval {
				continue
			}
			operation = deps.pull
		}
		uctx, cancel := context.WithTimeout(ctx, deps.timeout)
		uploaded, uploadErr := operation(uctx)
		cancel()
		if uploadErr != nil {
			if errors.Is(uploadErr, claude.ErrAuthUploadBlockedByLogout) {
				lastHandled = snap.Generation
				continue
			}
			if ctx.Err() != nil {
				return
			}
			if snap.Generation == failedGeneration {
				failedAttempts++
			} else {
				failedAttempts = 1
			}
			failedGeneration = snap.Generation
			retryAt = time.Now().Add(authRetryDelay(deps.backoff, deps.maxBackoff, failedAttempts))
			deps.logger.Warn("mid-session auth sync failed; will retry", "err", uploadErr)
			continue
		}
		// The store re-snapshots under its own lease, so it may have uploaded
		// a generation newer than the one this tick observed.
		if uploaded.Generation.Exists {
			lastHandled = uploaded.Generation
		} else {
			lastHandled = snap.Generation
		}
		lastPull = time.Now()
		failedGeneration = claude.AuthGeneration{}
		failedAttempts = 0
		deps.logger.Debug("mid-session auth synchronized")
	}
}

func authRetryDelay(base, maximum time.Duration, attempts int) time.Duration {
	delay := base
	for attempt := 1; attempt < attempts && delay < maximum; attempt++ {
		if delay >= maximum/2 {
			return maximum
		}
		delay *= 2
	}
	return delay
}

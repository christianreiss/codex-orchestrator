// Mid-session auth upload watcher. Claude Code rotates its OAuth pair
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
	authWatchInterval      = 30 * time.Second
	authWatchUploadTimeout = 15 * time.Second
	// A generation whose upload failed is retried, but not on every tick: the
	// next poll would hit the same server state, and the post-run upload is
	// still behind it as a backstop.
	authWatchRetryBackoff = 5 * time.Minute
)

type authWatchDeps struct {
	// snapshot reads the current native generation without taking the upload
	// transaction lease.
	snapshot func() (claude.AuthSnapshot, error)
	// upload runs the single automatic AuthStore transaction and returns the
	// exact snapshot it submitted.
	upload   func(context.Context) (claude.AuthSnapshot, error)
	interval time.Duration
	backoff  time.Duration
	timeout  time.Duration
	logger   *slog.Logger
}

// startMidSessionAuthUpload launches the watcher goroutine and returns an
// idempotent stop function that cancels it and waits for it to exit, so no
// watcher upload can overlap the post-run upload.
func startMidSessionAuthUpload(
	ctx context.Context,
	client *orchestrator.Client,
	logger *slog.Logger,
	before claude.AuthGeneration,
) (stop func()) {
	deps := authWatchDeps{
		snapshot: func() (claude.AuthSnapshot, error) { return claude.ReadAuthSnapshot(false) },
		upload: func(uctx context.Context) (claude.AuthSnapshot, error) {
			_, snap, err := storeChangedAuthCandidate(uctx, client)
			return snap, err
		},
		interval: authWatchInterval,
		backoff:  authWatchRetryBackoff,
		timeout:  authWatchUploadTimeout,
		logger:   logger,
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
	lastHandled := before
	var failedGeneration claude.AuthGeneration
	var failedAt time.Time
	ticker := time.NewTicker(deps.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		snap, err := deps.snapshot()
		if err != nil || !snap.Usable {
			// Absent, unreadable, or logged-out credentials are the post-run
			// handler's business (logout tracking), never the watcher's.
			continue
		}
		if snap.Generation == lastHandled {
			continue
		}
		if snap.Generation == failedGeneration && time.Since(failedAt) < deps.backoff {
			continue
		}
		uctx, cancel := context.WithTimeout(ctx, deps.timeout)
		uploaded, uploadErr := deps.upload(uctx)
		cancel()
		if uploadErr != nil {
			if errors.Is(uploadErr, claude.ErrAuthUploadBlockedByLogout) {
				lastHandled = snap.Generation
				continue
			}
			if ctx.Err() != nil {
				return
			}
			failedGeneration = snap.Generation
			failedAt = time.Now()
			deps.logger.Warn("mid-session auth upload failed; will retry", "err", uploadErr)
			continue
		}
		// The store re-snapshots under its own lease, so it may have uploaded
		// a generation newer than the one this tick observed.
		if uploaded.Generation.Exists {
			lastHandled = uploaded.Generation
		} else {
			lastHandled = snap.Generation
		}
		deps.logger.Debug("mid-session auth generation uploaded")
	}
}

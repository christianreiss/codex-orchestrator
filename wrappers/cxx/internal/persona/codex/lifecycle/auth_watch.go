// Mid-session auth convergence. Native rotations are offered promptly, while
// verified canonical changes are periodically adopted for native recovery and
// refresh. The wrapper never spends a provider refresh token itself.
package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/authnotice"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

const (
	authWatchInterval      = 2 * time.Second
	authWatchPullInterval  = 30 * time.Second
	authWatchUploadTimeout = 15 * time.Second
	authWatchRetryBackoff  = 5 * time.Second
	authWatchMaxBackoff    = time.Minute
)

type authWatchDeps struct {
	// snapshot reads the native file's content hash and last_refresh stamp
	// without taking the upload transaction lease.
	snapshot func() (hash string, refresh string)
	// upload runs the bounded store-candidate transaction (no local
	// write-back: the running child owns the credential file).
	upload       func(context.Context) error
	syncAuth     func(context.Context) (SessionAuthSyncResult, error)
	onAdopted    func(codex.AuthGeneration)
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
	authPath string,
	beforeHash, beforeRefresh string,
) (stop func()) {
	deps := authWatchDeps{
		snapshot: func() (string, string) { return snapshotAuth(authPath) },
		syncAuth: func(uctx context.Context) (SessionAuthSyncResult, error) {
			return SyncSessionAuth(uctx, client, logger)
		},
		onAdopted: func(generation codex.AuthGeneration) {
			if err := authnotice.Publish("codex", generation.Digest); err != nil {
				logger.Debug("session auth adoption notice deferred", "err", err)
			}
		},
		interval:     authWatchInterval,
		pullInterval: authWatchPullInterval,
		backoff:      authWatchRetryBackoff,
		maxBackoff:   authWatchMaxBackoff,
		timeout:      authWatchUploadTimeout,
		logger:       logger,
	}
	watchCtx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		runAuthUploadWatcher(watchCtx, deps, beforeHash, beforeRefresh)
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			wg.Wait()
		})
	}
}

func runAuthUploadWatcher(ctx context.Context, deps authWatchDeps, beforeHash, beforeRefresh string) {
	stateKey := func(hash, refresh string) string { return hash + "\x00" + refresh }
	lastHandled := stateKey(beforeHash, beforeRefresh)
	lastHandledGeneration := ""
	var failedState string
	var retryAt time.Time
	var retryDelay time.Duration
	nextPull := time.Now()
	immediate := deps.syncAuth != nil
	ticker := time.NewTicker(deps.interval)
	defer ticker.Stop()
	for {
		if !immediate {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
		immediate = false
		if ctx.Err() != nil {
			return
		}
		hash, refresh := deps.snapshot()
		if hash == "" {
			// Never repopulate auth removed by native logout or final purge.
			continue
		}
		observed := stateKey(hash, refresh)
		now := time.Now()
		pullDue := deps.syncAuth != nil && !now.Before(nextPull)
		if !pullDue && (observed == lastHandled || hash == lastHandledGeneration) {
			continue
		}
		if observed == failedState && now.Before(retryAt) {
			continue
		}
		uctx, cancel := context.WithTimeout(ctx, deps.timeout)
		var result SessionAuthSyncResult
		var err error
		if deps.syncAuth != nil {
			result, err = deps.syncAuth(uctx)
		} else {
			err = deps.upload(uctx)
		}
		cancel()
		if err != nil {
			if errors.Is(err, codex.ErrLogoutIntentActive) {
				lastHandled = observed
				continue
			}
			if ctx.Err() != nil {
				return
			}
			if failedState != observed || retryDelay == 0 {
				retryDelay = deps.backoff
			} else if deps.maxBackoff > 0 && retryDelay < deps.maxBackoff {
				retryDelay = min(retryDelay*2, deps.maxBackoff)
			}
			failedState = observed
			retryAt = time.Now().Add(retryDelay)
			deps.logger.Debug("mid-session auth sync failed; will retry", "err", err, "retry_in", retryDelay)
			continue
		}
		// The store snapshots the file under its own transaction and may have
		// uploaded a generation newer than this tick observed; marking only
		// the observed state handled means a mid-upload rotation is re-offered
		// next tick, where the server cheaply answers "valid".
		lastHandled = observed
		lastHandledGeneration = result.Generation.Digest
		failedState = ""
		retryDelay = 0
		nextPull = time.Now().Add(deps.pullInterval)
		if result.Adopted && deps.onAdopted != nil {
			deps.onAdopted(result.Generation)
		}
		deps.logger.Debug("mid-session auth synchronized", "uploaded", result.Uploaded, "adopted", result.Adopted, "deferred", result.Deferred)
	}
}

// Mid-session auth upload watcher. With the runner's verification probes now
// refresh-stripped, the first codex process to touch an expired-access
// credential is the fleet's refresher — and OpenAI rotates the refresh token
// per use, locking out replays beyond a short grace. Until the rotated pair
// reaches the orchestrator, every other host that launches is handed the
// spent parent and will replay it. The post-run upload alone leaves that gap
// open for the whole session, so this watcher polls the native auth.json
// while the child runs and uploads each new generation within one interval
// of its mint.
package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
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
	// snapshot reads the native file's content hash and last_refresh stamp
	// without taking the upload transaction lease.
	snapshot func() (hash string, refresh string)
	// upload runs the bounded store-candidate transaction (no local
	// write-back: the running child owns the credential file).
	upload   func(context.Context) error
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
	authPath string,
	beforeHash, beforeRefresh string,
) (stop func()) {
	deps := authWatchDeps{
		snapshot: func() (string, string) { return snapshotAuth(authPath) },
		upload: func(uctx context.Context) error {
			_, _, err := storeCurrentAuthCandidate(uctx, client, false)
			return err
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
	var failedState string
	var failedAt time.Time
	ticker := time.NewTicker(deps.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		hash, refresh := deps.snapshot()
		if hash == "" {
			// Absent or unreadable credentials are the post-run handler's
			// business (logout tracking), never the watcher's.
			continue
		}
		observed := stateKey(hash, refresh)
		if observed == lastHandled {
			continue
		}
		if observed == failedState && time.Since(failedAt) < deps.backoff {
			continue
		}
		uctx, cancel := context.WithTimeout(ctx, deps.timeout)
		err := deps.upload(uctx)
		cancel()
		if err != nil {
			if errors.Is(err, codex.ErrLogoutIntentActive) {
				lastHandled = observed
				continue
			}
			if ctx.Err() != nil {
				return
			}
			failedState = observed
			failedAt = time.Now()
			deps.logger.Warn("mid-session auth upload failed; will retry", "err", err)
			continue
		}
		// The store snapshots the file under its own transaction and may have
		// uploaded a generation newer than this tick observed; marking only
		// the observed state handled means a mid-upload rotation is re-offered
		// next tick, where the server cheaply answers "valid".
		lastHandled = observed
		deps.logger.Debug("mid-session auth generation uploaded")
	}
}

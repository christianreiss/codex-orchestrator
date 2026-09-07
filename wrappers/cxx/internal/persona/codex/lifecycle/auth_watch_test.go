package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
)

type watcherHarness struct {
	mu        sync.Mutex
	hash      string
	refresh   string
	uploads   int
	uploadErr error
}

func (h *watcherHarness) setState(hash, refresh string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.hash = hash
	h.refresh = refresh
}

func (h *watcherHarness) setUploadErr(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.uploadErr = err
}

func (h *watcherHarness) uploadCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.uploads
}

func (h *watcherHarness) deps(backoff time.Duration) authWatchDeps {
	return authWatchDeps{
		snapshot: func() (string, string) {
			h.mu.Lock()
			defer h.mu.Unlock()
			return h.hash, h.refresh
		},
		upload: func(context.Context) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.uploads++
			return h.uploadErr
		},
		interval: time.Millisecond,
		backoff:  backoff,
		timeout:  50 * time.Millisecond,
		logger:   slog.New(slog.DiscardHandler),
	}
}

func waitFor(t *testing.T, deadline time.Duration, cond func() bool) {
	t.Helper()
	stop := time.Now().Add(deadline)
	for time.Now().Before(stop) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	if !cond() {
		t.Fatal("condition not reached before deadline")
	}
}

// settle waits long enough for several ticks to pass so a wrongly repeating
// upload would have had every chance to fire.
func settle() { time.Sleep(25 * time.Millisecond) }

func TestAuthWatcherUploadsEachNewStateOnce(t *testing.T) {
	h := &watcherHarness{}
	h.setState("h1", "2026-08-08T10:00:00Z")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runAuthUploadWatcher(ctx, h.deps(time.Hour), "h0", "2026-08-08T09:00:00Z")
	}()

	waitFor(t, time.Second, func() bool { return h.uploadCount() == 1 })
	settle()
	if got := h.uploadCount(); got != 1 {
		t.Fatalf("unchanged state re-uploaded: %d uploads", got)
	}

	// A refresh-stamp-only change (same hash impossible in practice, but the
	// pair is the key) still counts as a new generation.
	h.setState("h2", "2026-08-08T11:00:00Z")
	waitFor(t, time.Second, func() bool { return h.uploadCount() == 2 })

	cancel()
	<-done
}

func TestAuthWatcherSkipsAbsentAuthFile(t *testing.T) {
	h := &watcherHarness{}
	h.setState("", "")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runAuthUploadWatcher(ctx, h.deps(time.Hour), "h0", "r0")
	}()

	settle()
	cancel()
	<-done
	if got := h.uploadCount(); got != 0 {
		t.Fatalf("absent auth file uploaded %d times", got)
	}
}

func TestAuthWatcherBacksOffFailedStateButNotNewOnes(t *testing.T) {
	h := &watcherHarness{}
	h.setState("h1", "r1")
	h.setUploadErr(errors.New("server did not accept the uploaded Codex credential generation"))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runAuthUploadWatcher(ctx, h.deps(time.Hour), "h0", "r0")
	}()

	waitFor(t, time.Second, func() bool { return h.uploadCount() == 1 })
	settle()
	if got := h.uploadCount(); got != 1 {
		t.Fatalf("failed state retried before backoff: %d uploads", got)
	}

	h.setState("h2", "r2")
	h.setUploadErr(nil)
	waitFor(t, time.Second, func() bool { return h.uploadCount() == 2 })

	cancel()
	<-done
}

func TestAuthWatcherRetriesFailedStateAfterBackoff(t *testing.T) {
	h := &watcherHarness{}
	h.setState("h1", "r1")
	h.setUploadErr(errors.New("store unavailable"))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runAuthUploadWatcher(ctx, h.deps(time.Millisecond), "h0", "r0")
	}()

	waitFor(t, time.Second, func() bool { return h.uploadCount() >= 2 })
	cancel()
	<-done
}

func TestAuthWatcherTreatsLogoutIntentAsHandled(t *testing.T) {
	h := &watcherHarness{}
	h.setState("h1", "r1")
	h.setUploadErr(codex.ErrLogoutIntentActive)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runAuthUploadWatcher(ctx, h.deps(time.Millisecond), "h0", "r0")
	}()

	waitFor(t, time.Second, func() bool { return h.uploadCount() == 1 })
	settle()
	cancel()
	<-done
	if got := h.uploadCount(); got != 1 {
		t.Fatalf("logout-blocked state retried: %d uploads", got)
	}
}

func TestAuthWatcherImmediatelyPullsThenPollsWithoutReuploadingAdoptedBytes(t *testing.T) {
	h := &watcherHarness{hash: "initial", refresh: "initial-refresh"}
	deps := h.deps(5 * time.Millisecond)
	deps.pullInterval = 30 * time.Millisecond
	var calls, notices int
	var mu sync.Mutex
	deps.syncAuth = func(context.Context) (SessionAuthSyncResult, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls == 1 {
			h.setState("adopted", "new-refresh")
			return SessionAuthSyncResult{Generation: codex.AuthGeneration{Exists: true, Digest: "adopted"}, Adopted: true}, nil
		}
		return SessionAuthSyncResult{Generation: codex.AuthGeneration{Exists: true, Digest: "adopted"}}, nil
	}
	deps.onAdopted = func(g codex.AuthGeneration) {
		mu.Lock()
		defer mu.Unlock()
		notices++
		if g.Digest != "adopted" {
			t.Error("notice identified a different generation")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); runAuthUploadWatcher(ctx, deps, "initial", "initial-refresh") }()
	waitFor(t, time.Second, func() bool { mu.Lock(); defer mu.Unlock(); return calls >= 2 })
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if calls > 3 || notices != 1 {
		t.Fatalf("adopted generation produced repeated sync/notices: calls=%d notices=%d", calls, notices)
	}
}

func TestAuthWatcherCancellationDrainsInflightSync(t *testing.T) {
	h := &watcherHarness{hash: "h", refresh: "r"}
	deps := h.deps(time.Second)
	deps.pullInterval = time.Hour
	started := make(chan struct{})
	drained := make(chan struct{})
	deps.syncAuth = func(ctx context.Context) (SessionAuthSyncResult, error) {
		close(started)
		<-ctx.Done()
		close(drained)
		return SessionAuthSyncResult{}, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); runAuthUploadWatcher(ctx, deps, "h", "r") }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("initial pull did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("watcher did not drain cancelled request")
	}
	select {
	case <-drained:
	default:
		t.Fatal("watcher exited before request drained")
	}
}

func TestAuthWatcherRetriesBackOffExponentiallyAndCap(t *testing.T) {
	h := &watcherHarness{hash: "h", refresh: "r"}
	deps := h.deps(8 * time.Millisecond)
	deps.maxBackoff = 24 * time.Millisecond
	deps.pullInterval = time.Hour
	var mu sync.Mutex
	var attempts []time.Time
	deps.syncAuth = func(context.Context) (SessionAuthSyncResult, error) {
		mu.Lock()
		attempts = append(attempts, time.Now())
		mu.Unlock()
		return SessionAuthSyncResult{}, errors.New("temporarily unavailable")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); runAuthUploadWatcher(ctx, deps, "h", "r") }()
	waitFor(t, time.Second, func() bool { mu.Lock(); defer mu.Unlock(); return len(attempts) >= 5 })
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	for i, want := range []time.Duration{8 * time.Millisecond, 16 * time.Millisecond, 24 * time.Millisecond, 24 * time.Millisecond} {
		if gap := attempts[i+1].Sub(attempts[i]); gap < want || gap > 150*time.Millisecond {
			t.Fatalf("retry gap%d=%s, expected >=%s with bounded scheduling slack", i, gap, want)
		}
	}
}

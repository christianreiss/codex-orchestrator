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

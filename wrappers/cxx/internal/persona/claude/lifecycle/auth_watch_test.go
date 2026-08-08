package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
)

type watcherHarness struct {
	mu           sync.Mutex
	snap         claude.AuthSnapshot
	snapErr      error
	uploads      int
	uploadErr    error
	uploadResult claude.AuthSnapshot
	// uploadSetsSnapshot mirrors the real store: the generation it reports
	// having uploaded is the file state, so later polls observe it too.
	uploadSetsSnapshot bool
}

func (h *watcherHarness) setSnapshot(snap claude.AuthSnapshot, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.snap = snap
	h.snapErr = err
}

func (h *watcherHarness) setUpload(result claude.AuthSnapshot, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.uploadResult = result
	h.uploadErr = err
}

func (h *watcherHarness) uploadCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.uploads
}

func (h *watcherHarness) deps(backoff time.Duration) authWatchDeps {
	return authWatchDeps{
		snapshot: func() (claude.AuthSnapshot, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			return h.snap, h.snapErr
		},
		upload: func(context.Context) (claude.AuthSnapshot, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.uploads++
			if h.uploadSetsSnapshot && h.uploadErr == nil {
				h.snap = h.uploadResult
			}
			return h.uploadResult, h.uploadErr
		},
		interval: time.Millisecond,
		backoff:  backoff,
		timeout:  50 * time.Millisecond,
		logger:   slog.New(slog.DiscardHandler),
	}
}

func generation(digest string) claude.AuthGeneration {
	return claude.AuthGeneration{Exists: true, Digest: digest}
}

func usableSnapshot(digest string) claude.AuthSnapshot {
	return claude.AuthSnapshot{Usable: true, Generation: generation(digest)}
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

func TestAuthWatcherUploadsEachNewGenerationOnce(t *testing.T) {
	h := &watcherHarness{}
	h.setSnapshot(usableSnapshot("g1"), nil)
	h.setUpload(usableSnapshot("g1"), nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runAuthUploadWatcher(ctx, h.deps(time.Hour), generation("g0"))
	}()

	waitFor(t, time.Second, func() bool { return h.uploadCount() == 1 })
	settle()
	if got := h.uploadCount(); got != 1 {
		t.Fatalf("unchanged generation re-uploaded: %d uploads", got)
	}

	h.setSnapshot(usableSnapshot("g2"), nil)
	h.setUpload(usableSnapshot("g2"), nil)
	waitFor(t, time.Second, func() bool { return h.uploadCount() == 2 })

	cancel()
	<-done
}

func TestAuthWatcherSkipsUnusableSnapshots(t *testing.T) {
	h := &watcherHarness{}
	h.setSnapshot(claude.AuthSnapshot{Usable: false, Generation: generation("g1")}, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runAuthUploadWatcher(ctx, h.deps(time.Hour), generation("g0"))
	}()

	settle()
	cancel()
	<-done
	if got := h.uploadCount(); got != 0 {
		t.Fatalf("unusable snapshot uploaded %d times", got)
	}
}

func TestAuthWatcherBacksOffFailedGeneration(t *testing.T) {
	h := &watcherHarness{}
	h.setSnapshot(usableSnapshot("g1"), nil)
	h.setUpload(claude.AuthSnapshot{}, errors.New("store unavailable"))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runAuthUploadWatcher(ctx, h.deps(time.Hour), generation("g0"))
	}()

	waitFor(t, time.Second, func() bool { return h.uploadCount() == 1 })
	settle()
	if got := h.uploadCount(); got != 1 {
		t.Fatalf("failed generation retried before backoff: %d uploads", got)
	}

	// A different (newer) generation is not throttled by the earlier failure.
	h.setSnapshot(usableSnapshot("g2"), nil)
	h.setUpload(usableSnapshot("g2"), nil)
	waitFor(t, time.Second, func() bool { return h.uploadCount() == 2 })

	cancel()
	<-done
}

func TestAuthWatcherRetriesFailedGenerationAfterBackoff(t *testing.T) {
	h := &watcherHarness{}
	h.setSnapshot(usableSnapshot("g1"), nil)
	h.setUpload(claude.AuthSnapshot{}, errors.New("store unavailable"))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runAuthUploadWatcher(ctx, h.deps(time.Millisecond), generation("g0"))
	}()

	waitFor(t, time.Second, func() bool { return h.uploadCount() >= 2 })
	cancel()
	<-done
}

func TestAuthWatcherTreatsLogoutBlockAsHandled(t *testing.T) {
	h := &watcherHarness{}
	h.setSnapshot(usableSnapshot("g1"), nil)
	h.setUpload(claude.AuthSnapshot{}, claude.ErrAuthUploadBlockedByLogout)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runAuthUploadWatcher(ctx, h.deps(time.Millisecond), generation("g0"))
	}()

	waitFor(t, time.Second, func() bool { return h.uploadCount() == 1 })
	settle()
	cancel()
	<-done
	if got := h.uploadCount(); got != 1 {
		t.Fatalf("logout-blocked generation retried: %d uploads", got)
	}
}

func TestAuthWatcherFollowsNewerUploadedGeneration(t *testing.T) {
	h := &watcherHarness{}
	h.uploadSetsSnapshot = true
	h.setSnapshot(usableSnapshot("g1"), nil)
	// The store re-snapshots under its lease and uploads g2 (the child rotated
	// again mid-upload); the watcher must treat g2 as handled and later polls
	// observe g2 as the file state.
	h.setUpload(usableSnapshot("g2"), nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runAuthUploadWatcher(ctx, h.deps(time.Hour), generation("g0"))
	}()

	waitFor(t, time.Second, func() bool { return h.uploadCount() >= 1 })
	settle()
	cancel()
	<-done
	if got := h.uploadCount(); got != 1 {
		t.Fatalf("already-uploaded generation re-uploaded: %d uploads", got)
	}
}

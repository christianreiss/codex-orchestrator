package agentbus

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
)

type authWatchHarness struct {
	mu       sync.Mutex
	snapshot claude.AuthSnapshot
	uploads  chan claude.AuthGeneration
	fail     map[claude.AuthGeneration]error
}

func newAuthWatchHarness(snapshot claude.AuthSnapshot) *authWatchHarness {
	return &authWatchHarness{
		snapshot: snapshot,
		uploads:  make(chan claude.AuthGeneration, 16),
		fail:     make(map[claude.AuthGeneration]error),
	}
}

func (h *authWatchHarness) read() (claude.AuthSnapshot, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.snapshot, nil
}

func (h *authWatchHarness) upload(context.Context) error {
	h.mu.Lock()
	generation := h.snapshot.Generation
	err := h.fail[generation]
	h.mu.Unlock()
	h.uploads <- generation
	return err
}

func (h *authWatchHarness) set(snapshot claude.AuthSnapshot) {
	h.mu.Lock()
	h.snapshot = snapshot
	h.mu.Unlock()
}

func usableAuthGeneration(digest string) claude.AuthSnapshot {
	return claude.AuthSnapshot{
		Generation: claude.AuthGeneration{Exists: true, Digest: digest},
		Usable:     true,
	}
}

func startAuthWatch(t *testing.T, harness *authWatchHarness, backoff time.Duration) (context.CancelFunc, <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runPersistentClaudeAuthWatchWithDeps(ctx, persistentClaudeAuthWatchDeps{
			snapshot: harness.read,
			upload:   harness.upload,
			interval: time.Millisecond,
			backoff:  backoff,
			maxDelay: backoff,
			timeout:  time.Second,
			logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("persistent auth watcher did not stop")
		}
	})
	return cancel, done
}

func awaitAuthUpload(t *testing.T, uploads <-chan claude.AuthGeneration) claude.AuthGeneration {
	t.Helper()
	select {
	case generation := <-uploads:
		return generation
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for persistent auth upload")
		return claude.AuthGeneration{}
	}
}

func assertNoAuthUpload(t *testing.T, uploads <-chan claude.AuthGeneration) {
	t.Helper()
	select {
	case generation := <-uploads:
		t.Fatalf("unexpected persistent auth upload for generation %+v", generation)
	case <-time.After(20 * time.Millisecond):
	}
}

func TestPersistentClaudeAuthWatchUploadsExistingAndChangedGenerations(t *testing.T) {
	first := usableAuthGeneration("first")
	second := usableAuthGeneration("second")
	harness := newAuthWatchHarness(first)
	startAuthWatch(t, harness, time.Hour)

	if got := awaitAuthUpload(t, harness.uploads); got != first.Generation {
		t.Fatalf("initial upload generation = %+v, want %+v", got, first.Generation)
	}
	assertNoAuthUpload(t, harness.uploads)

	harness.set(second)
	if got := awaitAuthUpload(t, harness.uploads); got != second.Generation {
		t.Fatalf("changed upload generation = %+v, want %+v", got, second.Generation)
	}
	assertNoAuthUpload(t, harness.uploads)
}

func TestPersistentClaudeAuthWatchSkipsUnusableGenerationUntilUsable(t *testing.T) {
	snapshot := usableAuthGeneration("login")
	snapshot.Usable = false
	harness := newAuthWatchHarness(snapshot)
	startAuthWatch(t, harness, time.Hour)
	assertNoAuthUpload(t, harness.uploads)

	snapshot.Usable = true
	harness.set(snapshot)
	if got := awaitAuthUpload(t, harness.uploads); got != snapshot.Generation {
		t.Fatalf("upload generation = %+v, want %+v", got, snapshot.Generation)
	}
}

func TestPersistentClaudeAuthWatchSkipsServerBoundStartupButUploadsNativeChange(t *testing.T) {
	canonical := usableAuthGeneration("canonical")
	canonical.ServerDigest = strings.Repeat("a", 64)
	refreshed := usableAuthGeneration("native-refresh")
	harness := newAuthWatchHarness(canonical)
	startAuthWatch(t, harness, time.Hour)
	assertNoAuthUpload(t, harness.uploads)

	harness.set(refreshed)
	if got := awaitAuthUpload(t, harness.uploads); got != refreshed.Generation {
		t.Fatalf("native refresh generation = %+v, want %+v", got, refreshed.Generation)
	}
}

func TestPersistentClaudeAuthWatchDoesNotLoseGenerationChangedDuringUpload(t *testing.T) {
	local := usableAuthGeneration("local")
	canonical := usableAuthGeneration("server-canonical")
	harness := newAuthWatchHarness(local)
	harnessUpload := harness.upload
	harness.uploads = make(chan claude.AuthGeneration, 16)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runPersistentClaudeAuthWatchWithDeps(ctx, persistentClaudeAuthWatchDeps{
			snapshot: harness.read,
			upload: func(ctx context.Context) error {
				err := harnessUpload(ctx)
				harness.set(canonical)
				return err
			},
			interval: time.Millisecond,
			backoff:  time.Hour,
			maxDelay: time.Hour,
			timeout:  time.Second,
			logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("persistent auth watcher did not stop")
		}
	})

	if got := awaitAuthUpload(t, harness.uploads); got != local.Generation {
		t.Fatalf("upload generation = %+v, want %+v", got, local.Generation)
	}
	if got := awaitAuthUpload(t, harness.uploads); got != canonical.Generation {
		t.Fatalf("generation changed during upload = %+v, want %+v", got, canonical.Generation)
	}
	assertNoAuthUpload(t, harness.uploads)
}

func TestPersistentClaudeAuthWatchBacksOffFailedGenerationButHandlesNewerOne(t *testing.T) {
	failed := usableAuthGeneration("failed")
	newer := usableAuthGeneration("newer")
	harness := newAuthWatchHarness(failed)
	harness.fail[failed.Generation] = errors.New("runner unavailable")
	startAuthWatch(t, harness, time.Hour)

	if got := awaitAuthUpload(t, harness.uploads); got != failed.Generation {
		t.Fatalf("failed upload generation = %+v, want %+v", got, failed.Generation)
	}
	assertNoAuthUpload(t, harness.uploads)

	harness.set(newer)
	if got := awaitAuthUpload(t, harness.uploads); got != newer.Generation {
		t.Fatalf("newer upload generation = %+v, want %+v", got, newer.Generation)
	}
}

func TestPersistentClaudeAuthWatchBackoffIsBounded(t *testing.T) {
	tests := []struct {
		attempts int
		want     time.Duration
	}{
		{attempts: 0, want: 5 * time.Second},
		{attempts: 1, want: 5 * time.Second},
		{attempts: 2, want: 10 * time.Second},
		{attempts: 3, want: 20 * time.Second},
		{attempts: 8, want: 5 * time.Minute},
		{attempts: 100, want: 5 * time.Minute},
	}
	for _, testCase := range tests {
		if got := exponentialBackoff(5*time.Second, 5*time.Minute, testCase.attempts); got != testCase.want {
			t.Fatalf("attempts %d: backoff = %s, want %s", testCase.attempts, got, testCase.want)
		}
	}
}

package agentbus

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

type authWatchHarness struct {
	mu       sync.Mutex
	snapshot persistentAuthSnapshot
	uploads  chan persistentAuthGeneration
	fail     map[persistentAuthGeneration]error
}

func persistentAuthFiles(t *testing.T, engine string) (authPath, markerPath string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("CDX_CONFIG_PATH", filepath.Join(home, "cdx.json"))
	t.Setenv("CLX_CONFIG_PATH", filepath.Join(home, "clx.json"))
	configPath, err := config.DefaultPathForEngine(engine)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".codex", "auth.json")
	marker := filepath.Join(home, ".codex", ".cdx-logout-intent.json")
	raw := `{"tokens":{"access_token":"existing-native"}}`
	if engine == config.EngineClaude {
		path = filepath.Join(home, ".claude", ".credentials.json")
		marker = filepath.Join(home, ".clx", "auth", "logout-intent.json")
		raw = `{"claudeAiOauth":{"accessToken":"existing-native"}}`
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(marker), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	return path, marker
}

func TestPersistentAuthSnapshotSkipsAnyLogoutIntentWithoutChangingNativeCredentials(t *testing.T) {
	for _, engine := range []string{config.EngineCodex, config.EngineClaude} {
		t.Run(engine, func(t *testing.T) {
			path, marker := persistentAuthFiles(t, engine)
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			snap, err := persistentAuthSnapshotForEngine(context.Background(), engine)
			if err != nil || !snap.Usable {
				t.Fatalf("ordinary native generation was unavailable: usable=%v err=%v", snap.Usable, err)
			}
			// A durable marker may govern retained native bytes or precede a
			// late native rotation. The idle worker has no explicit-login authority.
			if err := os.WriteFile(marker, []byte(`{"nonce":"explicit-logout"}`), 0o600); err != nil {
				t.Fatal(err)
			}
			snap, err = persistentAuthSnapshotForEngine(context.Background(), engine)
			if err != nil || snap.Usable {
				t.Fatalf("logged-out credentials became an automatic candidate: usable=%v err=%v", snap.Usable, err)
			}
			after, err := os.ReadFile(path)
			if err != nil || string(after) != string(before) {
				t.Fatalf("read-only snapshot changed retained native credentials: err=%v", err)
			}
			if _, err := os.Stat(marker); err != nil {
				t.Fatalf("read-only snapshot acknowledged logout: %v", err)
			}
		})
	}
}

func TestPersistentAuthWatchUsesAutomaticUploadCommand(t *testing.T) {
	original := runPersistentAuthCommand
	t.Cleanup(func() { runPersistentAuthCommand = original })
	for _, engine := range []string{config.EngineCodex, config.EngineClaude} {
		t.Run(engine, func(t *testing.T) {
			persistentAuthFiles(t, engine)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			called := false
			runPersistentAuthCommand = func(_ context.Context, gotEngine, command string) error {
				called = true
				cancel()
				if gotEngine != engine || command != "auth-upload-auto" {
					t.Errorf("idle command = %s %s, want %s auth-upload-auto", gotEngine, command, engine)
				}
				return nil
			}
			runPersistentAuthWatch(ctx, engine, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if !called {
				t.Fatal("pending native generation never reached automatic upload")
			}
		})
	}
}

func TestPersistentAuthWatchArbitratesUnboundActiveCredentials(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		t.Run(engine, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			harness := newAuthWatchHarness(usableAuthGeneration("unsent-local"))
			converged := make(chan struct{}, 1)
			done := make(chan struct{})
			go func() {
				defer close(done)
				runPersistentAuthWatchWithDeps(ctx, persistentAuthWatchDeps{
					engine: engine, snapshot: harness.read, upload: harness.upload,
					active: func() (bool, error) { return true, nil },
					sync: func(context.Context) error {
						winner := usableAuthGeneration("verified-canonical-winner")
						winner.ServerDigest = "canonical-binding"
						harness.set(winner)
						converged <- struct{}{}
						return nil
					},
					interval: time.Millisecond, syncInterval: time.Hour,
				})
			}()
			select {
			case <-converged:
			case <-time.After(time.Second):
				cancel()
				t.Fatal("active local candidate never reached canonical arbitration")
			}
			assertNoAuthUpload(t, harness.uploads)
			cancel()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("watcher did not stop")
			}
		})
	}
}

func TestPersistentAuthWatchOffersUnboundGenerationAfterActiveSyncBecomesIdle(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		t.Run(engine, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			harness := newAuthWatchHarness(usableAuthGeneration("unsent-local"))
			var active atomic.Bool
			active.Store(true)
			done := make(chan struct{})
			go func() {
				defer close(done)
				runPersistentAuthWatchWithDeps(ctx, persistentAuthWatchDeps{
					engine: engine, snapshot: harness.read, upload: harness.upload,
					active: func() (bool, error) { return active.Load(), nil },
					sync: func(context.Context) error {
						// The native child exits after the parent activity check;
						// auth-sync sees an idle host and successfully does nothing.
						active.Store(false)
						return nil
					},
					interval: time.Millisecond, syncInterval: time.Hour,
					backoff: 5 * time.Millisecond, maxDelay: 5 * time.Millisecond,
					logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
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
			if got := awaitAuthUpload(t, harness.uploads); got != usableAuthGeneration("unsent-local").Generation {
				t.Fatalf("idle upload = %+v, want original unbound generation", got)
			}
			assertNoAuthUpload(t, harness.uploads)
		})
	}
}

func TestPersistentAuthWatchRetriesDeferredActiveGenerationWithBackoff(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		t.Run(engine, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			harness := newAuthWatchHarness(usableAuthGeneration("unsent-local"))
			synced := make(chan persistentAuthGeneration, 8)
			done := make(chan struct{})
			go func() {
				defer close(done)
				runPersistentAuthWatchWithDeps(ctx, persistentAuthWatchDeps{
					engine: engine, snapshot: harness.read, upload: harness.upload,
					active: func() (bool, error) { return true, nil },
					sync: func(context.Context) error {
						snap, _ := harness.read()
						synced <- snap.Generation
						return nil // Deferred success leaves no accepted binding.
					},
					interval: time.Millisecond, syncInterval: time.Hour,
					backoff: 80 * time.Millisecond, maxDelay: 80 * time.Millisecond,
					logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
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
			first := awaitAuthUpload(t, synced)
			assertNoAuthUpload(t, synced)
			if got := awaitAuthUpload(t, synced); got != first {
				t.Fatalf("retry generation = %+v, want %+v", got, first)
			}
			assertNoAuthUpload(t, harness.uploads)
		})
	}
}

func TestPersistentAuthSyncRequiresActiveChildAndRetainsPollingUnchangedGeneration(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		t.Run(engine, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var active atomic.Bool
			synced := make(chan struct{}, 8)
			done := make(chan struct{})
			go func() {
				defer close(done)
				runPersistentAuthWatchWithDeps(ctx, persistentAuthWatchDeps{
					engine: engine,
					snapshot: func() (persistentAuthSnapshot, error) {
						return persistentAuthSnapshot{Generation: persistentAuthGeneration{Exists: true, Digest: "known"}, Usable: true, ServerDigest: "canonical"}, nil
					},
					upload:   func(context.Context) error { t.Error("known canonical uploaded"); return nil },
					active:   func() (bool, error) { return active.Load(), nil },
					sync:     func(context.Context) error { synced <- struct{}{}; return nil },
					interval: time.Millisecond, syncInterval: 5 * time.Millisecond,
				})
			}()
			select {
			case <-synced:
				t.Fatal("idle credentials triggered network sync")
			case <-time.After(15 * time.Millisecond):
			}
			active.Store(true)
			for i := 0; i < 2; i++ {
				select {
				case <-synced:
				case <-time.After(time.Second):
					t.Fatal("unchanged active generation stopped polling")
				}
			}
			cancel()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("watcher did not stop")
			}
		})
	}
}

func TestPersistentAuthSyncCancellationDrainsInFlightRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	entered := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		runPersistentAuthWatchWithDeps(ctx, persistentAuthWatchDeps{
			snapshot: func() (persistentAuthSnapshot, error) {
				return persistentAuthSnapshot{Generation: persistentAuthGeneration{Exists: true, Digest: "known"}, Usable: true, ServerDigest: "canonical"}, nil
			},
			active: func() (bool, error) { return true, nil },
			sync:   func(ctx context.Context) error { close(entered); <-ctx.Done(); return ctx.Err() },
		})
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		cancel()
		t.Fatal("sync not started")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancel left auth subprocess running")
	}
}

func newAuthWatchHarness(snapshot persistentAuthSnapshot) *authWatchHarness {
	return &authWatchHarness{
		snapshot: snapshot,
		uploads:  make(chan persistentAuthGeneration, 16),
		fail:     make(map[persistentAuthGeneration]error),
	}
}

func (h *authWatchHarness) read() (persistentAuthSnapshot, error) {
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

func (h *authWatchHarness) set(snapshot persistentAuthSnapshot) {
	h.mu.Lock()
	h.snapshot = snapshot
	h.mu.Unlock()
}

func usableAuthGeneration(digest string) persistentAuthSnapshot {
	return persistentAuthSnapshot{
		Generation: persistentAuthGeneration{Exists: true, Digest: digest},
		Usable:     true,
	}
}

func startAuthWatch(t *testing.T, harness *authWatchHarness, backoff time.Duration) (context.CancelFunc, <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runPersistentAuthWatchWithDeps(ctx, persistentAuthWatchDeps{
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

func awaitAuthUpload(t *testing.T, uploads <-chan persistentAuthGeneration) persistentAuthGeneration {
	t.Helper()
	select {
	case generation := <-uploads:
		return generation
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for persistent auth upload")
		return persistentAuthGeneration{}
	}
}

func assertNoAuthUpload(t *testing.T, uploads <-chan persistentAuthGeneration) {
	t.Helper()
	select {
	case generation := <-uploads:
		t.Fatalf("unexpected persistent auth upload for generation %+v", generation)
	case <-time.After(20 * time.Millisecond):
	}
}

func TestPersistentAuthWatchUploadsExistingAndChangedGenerations(t *testing.T) {
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

func TestPersistentAuthWatchSkipsUnusableGenerationUntilUsable(t *testing.T) {
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

func TestPersistentAuthWatchSkipsServerBoundStartupButUploadsNativeChange(t *testing.T) {
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

func TestPersistentAuthWatchDoesNotLoseGenerationChangedDuringUpload(t *testing.T) {
	local := usableAuthGeneration("local")
	canonical := usableAuthGeneration("server-canonical")
	harness := newAuthWatchHarness(local)
	harnessUpload := harness.upload
	harness.uploads = make(chan persistentAuthGeneration, 16)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runPersistentAuthWatchWithDeps(ctx, persistentAuthWatchDeps{
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

func TestPersistentAuthWatchBacksOffFailedGenerationButHandlesNewerOne(t *testing.T) {
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

func TestPersistentAuthWatchBackoffIsBounded(t *testing.T) {
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

package claudeconfiglock

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fastOpts never really sleeps: the fake clock advances by the requested delay.
func fastOpts(budget time.Duration) (Options, *int) {
	now := time.Now()
	sleeps := 0
	return Options{
		Budget: budget,
		Now:    func() time.Time { return now },
		Sleep:  func(d time.Duration) { sleeps++; now = now.Add(d) },
	}, &sleeps
}

func configPath(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), ".claude.json")
	if err := os.WriteFile(p, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestAcquireCreatesAndReleasesLockDirectory(t *testing.T) {
	p := configPath(t)
	l, err := Acquire(p, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(p + ".lock"); err != nil || !st.IsDir() {
		t.Fatalf("lock must be a directory at <config>.lock: %v", err)
	}
	if err := l.Check(); err != nil {
		t.Fatalf("fresh lock check: %v", err)
	}
	if err := l.Release(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p + ".lock"); !os.IsNotExist(err) {
		t.Fatalf("release must rmdir the lock: %v", err)
	}
}

func TestLiveHolderIsNotStolenAndExhaustsBudget(t *testing.T) {
	p := configPath(t)
	dir := Path(p)
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 9s old: still inside native's 10s stale window, so a live holder.
	held := time.Now().Add(-9 * time.Second)
	if err := os.Chtimes(dir, held, held); err != nil {
		t.Fatal(err)
	}
	// Real clock (ages must be real against the on-disk mtime), short budget.
	_, err := Acquire(p, Options{Budget: 30 * time.Millisecond})
	if !errors.Is(err, ErrLocked) {
		t.Fatalf("live lock acquire = %v, want ErrLocked", err)
	}
	var held2 *HeldError
	if !errors.As(err, &held2) || held2.Path != dir {
		t.Fatalf("error must name the lock path: %v", err)
	}
	st, err := os.Stat(dir)
	if err != nil || !st.ModTime().Equal(held) {
		t.Fatalf("live lock must stay in place with its mtime untouched: %v %v", st, err)
	}
}

func TestBudgetBoundsRetries(t *testing.T) {
	p := configPath(t)
	if err := os.Mkdir(Path(p), 0o755); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	opts, sleeps := fastOpts(3 * time.Second)
	// The lock's mtime is real "now"; keep the fake clock from aging it into
	// staleness by using a stale threshold beyond the budget.
	opts.Stale = time.Hour
	if _, err := Acquire(p, opts); !errors.Is(err, ErrLocked) {
		t.Fatalf("want ErrLocked, got %v", err)
	}
	if *sleeps < 3 {
		t.Fatalf("expected several backoff retries, got %d", *sleeps)
	}
	if time.Since(start) > time.Second {
		t.Fatal("fake sleeps must keep the test fast")
	}
}

func TestStaleLockIsTakenOverLikeNative(t *testing.T) {
	p := configPath(t)
	dir := Path(p)
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-11 * time.Second)
	if err := os.Chtimes(dir, old, old); err != nil {
		t.Fatal(err)
	}
	l, err := Acquire(p, Options{Budget: 10 * time.Millisecond})
	if err != nil {
		t.Fatalf("stale lock must be taken over: %v", err)
	}
	st, err := os.Stat(dir)
	if err != nil || !st.ModTime().After(old) {
		t.Fatalf("takeover must recreate the directory: %v", err)
	}
	if err := l.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestStaleRegularFileIsNeverUnlinked(t *testing.T) {
	p := configPath(t)
	dir := Path(p)
	if err := os.WriteFile(dir, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Minute)
	if err := os.Chtimes(dir, old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(p, Options{Budget: 10 * time.Millisecond}); err == nil {
		t.Fatal("a non-directory lock path must not be acquired")
	}
	if b, err := os.ReadFile(dir); err != nil || string(b) != "x" {
		t.Fatalf("foreign file must survive: %q %v", b, err)
	}
}

func TestDanglingSymlinkAtLockPathIsLockedNotLooped(t *testing.T) {
	p := configPath(t)
	if err := os.Symlink(filepath.Join(t.TempDir(), "gone"), Path(p)); err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(p, Options{Budget: 10 * time.Millisecond}); !errors.Is(err, ErrLocked) {
		t.Fatalf("dangling symlink lock = %v, want ErrLocked", err)
	}
	if _, err := os.Lstat(Path(p)); err != nil {
		t.Fatalf("foreign symlink must survive: %v", err)
	}
}

func TestLostLockIsDetectedAndForeignLockSurvivesRelease(t *testing.T) {
	p := configPath(t)
	l, err := Acquire(p, Options{})
	if err != nil {
		t.Fatal(err)
	}
	// Another process judged us stale and replaced the directory.
	if err := os.Remove(Path(p)); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(Path(p), 0o755); err != nil {
		t.Fatal(err)
	}
	foreign := time.Now().Add(time.Second)
	if err := os.Chtimes(Path(p), foreign, foreign); err != nil {
		t.Fatal(err)
	}
	if err := l.Check(); !errors.Is(err, ErrLost) {
		t.Fatalf("check after replacement = %v, want ErrLost", err)
	}
	if err := l.Release(); !errors.Is(err, ErrLost) {
		t.Fatalf("release after replacement = %v, want ErrLost", err)
	}
	if _, err := os.Stat(Path(p)); err != nil {
		t.Fatalf("release must not remove a foreign holder's lock: %v", err)
	}
}

func TestLongHoldIsTreatedAsLost(t *testing.T) {
	p := configPath(t)
	now := time.Now()
	l, err := Acquire(p, Options{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(Stale / 2)
	if err := l.Check(); !errors.Is(err, ErrLost) {
		t.Fatalf("a hold past native's refresh interval must count as lost, got %v", err)
	}
	_ = l.Release()
}

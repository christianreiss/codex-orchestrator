package ipc

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAcquireReleaseRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", dir)
	l, err := Acquire("cdx-test")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "cdx-test.lock")); statErr != nil {
		t.Fatalf("lock file missing: %v", statErr)
	}
	if err := l.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
}

// TestCountActiveReturnsAtLeastOne covers the floor case — CountActive must
// never report fewer than one peer, since the calling process itself is
// always alive. The exact count depends on what's running on the host, so
// we only assert the minimum invariant.
func TestCountActiveReturnsAtLeastOne(t *testing.T) {
	// Pick a binary name that's effectively guaranteed not to be running
	// (longer than /proc/comm's 15-char cap → no real process matches).
	got := CountActive("definitely-not-a-real-binary-foo")
	if got < 1 {
		t.Fatalf("CountActive must floor at 1, got %d", got)
	}
}

func TestAcquireBlocksWhenHeld(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", dir)
	first, err := Acquire("cdx-test")
	if err != nil {
		t.Fatalf("acquire #1: %v", err)
	}
	defer first.Release()
	_, err = Acquire("cdx-test")
	if !errors.Is(err, ErrHeld) {
		t.Fatalf("expected ErrHeld, got %v", err)
	}
}
